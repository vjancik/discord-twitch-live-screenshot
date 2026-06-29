FROM oven/bun:1.3.14-slim AS base
WORKDIR /usr/src/app

# Download the embedded ffmpeg binary in an isolated stage so the toolchain used
# to fetch it (wget/tar/xz) never lands in the final image.
FROM base AS download_dependencies
ARG TARGETARCH

RUN --mount=type=cache,id=apt-cache-$TARGETARCH,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib-$TARGETARCH,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates wget xz-utils \
    && mkdir -p ./bin

# BtbN publishes statically-linked, single-binary ffmpeg builds (no shared-lib
# dependencies), which is why they run on the slim base with nothing else added.
# The "latest" tag is a rolling release with stable asset names. The archive
# unpacks to <name>/bin/ffmpeg; we only need ffmpeg (no ffprobe).
RUN --mount=type=cache,id=ffmpeg-btbn-latest-$TARGETARCH,target=/cache \
    if [ "$TARGETARCH" = "amd64" ]; then \
        FFMPEG_VARIANT="linux64"; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        FFMPEG_VARIANT="linuxarm64"; \
    else \
        echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1; \
    fi \
    && FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${FFMPEG_VARIANT}-gpl.tar.xz" \
    && ( [ -s /cache/ffmpeg ] || ( \
        wget -q --show-progress --progress=bar:force -O /cache/ffmpeg.tar.xz "$FFMPEG_URL" \
        && tar -xf /cache/ffmpeg.tar.xz --wildcards --strip-components=2 -C /cache "*/bin/ffmpeg" \
        && rm /cache/ffmpeg.tar.xz ) ) \
    && cp /cache/ffmpeg ./bin/ffmpeg \
    && chmod +x ./bin/ffmpeg

# Install production dependencies in isolation so devDependencies stay out of the
# final image (and the install layer caches independently of the source).
FROM base AS install
ARG TARGETARCH
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN --mount=type=cache,id=bun-$TARGETARCH,target=/root/.bun/install/cache \
    cd /temp/prod && bun install --frozen-lockfile --production

FROM base AS release
ARG TARGETARCH
# The static ffmpeg validates HTTPS (Twitch's playlist/segment hosts) against a
# CA bundle, which the slim base does not ship. Without it, ffmpeg fails with
# "certificate verify failed". ca-certificates installs the trust store.
RUN --mount=type=cache,id=apt-cache-$TARGETARCH,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib-$TARGETARCH,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# BtbN's static ffmpeg bundles its own OpenSSL, whose compiled-in cert path is
# not Debian's. Point it at the installed bundle explicitly; OpenSSL reads
# SSL_CERT_FILE. Without this, TLS verification fails even with the bundle present.
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Place the embedded ffmpeg on a PATH dir owned by the runtime user. With ffmpeg
# on PATH, the app's default ffmpegPath of "ffmpeg" resolves it — no FFMPEG_PATH
# override needed.
RUN mkdir -p /home/bun/.local/bin
COPY --from=download_dependencies /usr/src/app/bin/ffmpeg /home/bun/.local/bin/ffmpeg
RUN chown -R bun:bun /home/bun/.local

COPY --from=install /temp/prod/node_modules node_modules
COPY src ./src
COPY package.json tsconfig.json ./

ENV NODE_ENV=production
ENV PATH="/home/bun/.local/bin:${PATH}"

USER bun
ENTRYPOINT [ "bun" ]
CMD [ "run", "start" ]
