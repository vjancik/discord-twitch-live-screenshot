import { SlashCommandBuilder } from "discord.js";

/** The `/twitch_screenshot` slash command name. */
export const COMMAND_NAME = "twitch_screenshot";

/** The `channel_url` option name on the slash command. */
export const OPTION_CHANNEL_URL = "channel_url";

/** Builder for the `/twitch_screenshot channel_url:<string>` command. */
export const twitchScreenshotCommand = new SlashCommandBuilder()
	.setName(COMMAND_NAME)
	.setDescription(
		"Capture a source-quality screenshot of a live Twitch channel.",
	)
	.addStringOption((option) =>
		option
			.setName(OPTION_CHANNEL_URL)
			.setDescription("Twitch channel URL (e.g. https://twitch.tv/somechannel)")
			.setRequired(true),
	);
