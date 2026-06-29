import { REST, Routes } from "discord.js";
import { loadConfig } from "../config";
import { createLogger } from "../logger";
import { twitchScreenshotCommand } from "./command";

/**
 * Register the application's slash commands with Discord.
 *
 * Run via `bun run deploy-commands`. If `DEV_GUILD_ID` is set, commands are
 * registered to that guild (instant); otherwise they are registered globally
 * (may take up to ~1h to propagate).
 */
async function main(): Promise<void> {
	const config = loadConfig();
	const logger = createLogger(config.logLevel);
	const rest = new REST().setToken(config.discordToken);
	const body = [twitchScreenshotCommand.toJSON()];

	const route =
		config.devGuildId !== undefined
			? Routes.applicationGuildCommands(config.discordAppId, config.devGuildId)
			: Routes.applicationCommands(config.discordAppId);

	logger.info(
		{
			scope:
				config.devGuildId !== undefined
					? `guild ${config.devGuildId}`
					: "global",
		},
		"Registering slash commands",
	);
	await rest.put(route, { body });
	logger.info("Slash commands registered");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
