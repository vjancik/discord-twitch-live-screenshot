import { type Client, codeBlock, type SendableChannels } from "discord.js";
import type { AuditLogger, Logger } from "../../domain/ports";

/**
 * {@link AuditLogger} that posts auth-contract events to a configured Discord
 * channel. Failures to post are swallowed (logged only) so auditing never
 * breaks the primary flow.
 */
export class DiscordAuditLogger implements AuditLogger {
	constructor(
		private readonly client: Client,
		private readonly channelId: string,
		private readonly logger: Logger,
	) {}

	async reportAuthFailure(detail: {
		channel: string;
		message: string;
		stage: string;
		status?: number;
		body?: string;
	}): Promise<void> {
		const lines = [
			"🚨 **Twitch auth contract failure**",
			`Channel: \`${detail.channel}\``,
			`Stage: \`${detail.stage}\`${detail.status !== undefined ? ` · HTTP \`${detail.status}\`` : ""}`,
			`Message: ${detail.message}`,
		];
		if (detail.body) {
			lines.push(codeBlock(detail.body.slice(0, 1500)));
		}
		lines.push(
			"_The anonymous GQL/usher flow may have changed — cross-check yt-dlp/streamlink (see README)._",
		);
		await this.post(lines.join("\n"));
	}

	async reportRecovery(detail: { channel: string }): Promise<void> {
		await this.post(
			`✅ **Twitch auth contract recovered** — retrieval succeeded again (channel \`${detail.channel}\`).`,
		);
	}

	/** Resolve and send to the audit channel, never throwing on failure. */
	private async post(content: string): Promise<void> {
		try {
			const channel = await this.client.channels.fetch(this.channelId);
			if (channel === null || !channel.isSendable()) {
				this.logger.error(
					{ channelId: this.channelId },
					"Audit channel is not sendable",
				);
				return;
			}
			await (channel as SendableChannels).send({
				content,
				allowedMentions: { parse: [] },
			});
		} catch (err) {
			this.logger.error(
				{ err, channelId: this.channelId },
				"Failed to post audit message",
			);
		}
	}
}
