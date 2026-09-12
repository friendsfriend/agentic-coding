/**
 * Markdown syntax style for OpenTUI's <code filetype="markdown"> element.
 *
 * Uses active OpenCode-compatible theme tokens instead of fixed Catppuccin
 * values. SyntaxStyle objects are cached per active theme because native style
 * instances are immutable after creation.
 */

import { SyntaxStyle } from "@opentui/core";
import { uiColors } from "./colors";
import { getActiveThemeName } from "./theme";

const markdownSyntaxStyleCache = new Map<string, SyntaxStyle>();

/**
 * Returns a SyntaxStyle suitable for <code filetype="markdown">.
 * Cached per active theme so theme switching updates markdown colors.
 */
export function getMarkdownSyntaxStyle(): SyntaxStyle {
	const themeName = getActiveThemeName();
	const cached = markdownSyntaxStyleCache.get(themeName);
	if (cached) return cached;

	const style = SyntaxStyle.fromTheme([
		// Default text
		{
			scope: ["default"],
			style: { foreground: uiColors.textPrimary },
		},

		// Headings — primary, bold
		{
			scope: [
				"markup.heading",
				"markup.heading.1",
				"markup.heading.2",
				"markup.heading.3",
				"markup.heading.4",
				"markup.heading.5",
				"markup.heading.6",
			],
			style: { foreground: uiColors.primary, bold: true },
		},

		// Bold / strong — accent, bold
		{
			scope: ["markup.bold", "markup.strong"],
			style: { foreground: uiColors.accent, bold: true },
		},

		// Italic / emphasis — highlight, italic
		{
			scope: ["markup.italic", "markup.emph"],
			style: { foreground: uiColors.highlight, italic: true },
		},

		// Lists — secondary text
		{
			scope: ["markup.list"],
			style: { foreground: uiColors.textSecondary },
		},

		// Block quotes — info, italic
		{
			scope: ["markup.quote"],
			style: { foreground: uiColors.info, italic: true },
		},

		// Inline code — success
		{
			scope: ["markup.raw", "markup.raw.inline"],
			style: { foreground: uiColors.success },
		},

		// Code blocks — success
		{
			scope: ["markup.raw.block"],
			style: { foreground: uiColors.success },
		},

		// Links — primary dim, underline
		{
			scope: ["markup.link", "markup.link.url"],
			style: { foreground: uiColors.primaryDim, underline: true },
		},

		// Link text labels — accent, underline
		{
			scope: ["markup.link.label"],
			style: { foreground: uiColors.accent, underline: true },
		},

		// Horizontal rule — muted text
		{
			scope: ["markup.thematic_break"],
			style: { foreground: uiColors.textMuted },
		},

		// Comments / muted
		{
			scope: ["conceal"],
			style: { foreground: uiColors.textMuted },
		},
	]);

	markdownSyntaxStyleCache.set(themeName, style);
	return style;
}
