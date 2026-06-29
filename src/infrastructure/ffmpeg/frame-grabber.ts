import { spawn } from "bun";
import { RetrievalError } from "../../domain/errors";
import type { FrameGrabber, Logger } from "../../domain/ports";

/** PNG magic bytes, used to sanity-check ffmpeg's output. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * {@link FrameGrabber} that shells out to a system `ffmpeg` binary to capture a
 * single lossless PNG frame from an HLS stream URL, returned on stdout.
 *
 * `-frames:v 1` grabs one frame; `-c:v png -f image2pipe pipe:1` encodes it
 * losslessly to stdout. No `-vf scale`, so the frame keeps its native source
 * resolution.
 */
export class FfmpegFrameGrabber implements FrameGrabber {
	constructor(
		private readonly logger: Logger,
		private readonly ffmpegPath = "ffmpeg",
		/** Hard timeout (ms) so a stalled ffmpeg can't hang a request forever. */
		private readonly timeoutMs = 30_000,
	) {}

	async grabFrame(streamUrl: string): Promise<Buffer> {
		const args = [
			"-loglevel",
			"error",
			// Take the freshest available segment near the live edge.
			"-live_start_index",
			"-1",
			"-i",
			streamUrl,
			"-frames:v",
			"1",
			"-c:v",
			"png",
			"-f",
			"image2pipe",
			"pipe:1",
		];

		const proc = spawn([this.ffmpegPath, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const timer = setTimeout(() => proc.kill(), this.timeoutMs);
		let stdout: ArrayBuffer;
		let stderr: string;
		let exitCode: number;
		try {
			[stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).arrayBuffer(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
		} finally {
			clearTimeout(timer);
		}

		const buffer = Buffer.from(stdout);

		if (exitCode !== 0) {
			throw new RetrievalError(
				`ffmpeg exited with code ${exitCode}: ${stderr.slice(0, 300)}`,
			);
		}
		if (buffer.byteLength === 0 || !buffer.subarray(0, 4).equals(PNG_MAGIC)) {
			throw new RetrievalError(
				`ffmpeg produced no valid PNG output: ${stderr.slice(0, 300)}`,
			);
		}

		this.logger.debug({ bytes: buffer.byteLength }, "ffmpeg captured frame");
		return buffer;
	}
}
