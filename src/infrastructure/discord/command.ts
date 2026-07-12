import {
	ApplicationCommandType,
	ContextMenuCommandBuilder,
	InteractionContextType,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from "discord.js";

/** The `/twitch_screenshot` slash command name. */
export const COMMAND_NAME = "twitch_screenshot";

/** The "(Un)Spoiler" message context menu command name. */
export const SPOILER_COMMAND_NAME = "(Un)Spoiler";

/** The `channel_url` option name on the slash command. */
export const OPTION_CHANNEL_URL = "channel_url";

/** The optional `spoiler` boolean option name on the slash command. */
export const OPTION_SPOILER = "spoiler";

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
	)
	.addBooleanOption((option) =>
		option
			.setName(OPTION_SPOILER)
			.setDescription("Post the screenshot spoilered (default: false).")
			.setRequired(false),
	);

/**
 * Builder for the "(Un)Spoiler" message context menu command: toggles the
 * spoiler state of attachments on one of the bot's own posts. Registered as
 * admin-only (default member permissions) and guild-only; the bot additionally
 * enforces the Administrator check at runtime.
 */
export const unSpoilerCommand = new ContextMenuCommandBuilder()
	.setName(SPOILER_COMMAND_NAME)
	.setType(ApplicationCommandType.Message)
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	.setContexts(InteractionContextType.Guild);
