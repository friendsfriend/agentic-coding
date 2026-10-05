/**
 * Markdown syntax style for OpenTUI's <code filetype="markdown"> element.
 *
 * Uses active OpenCode-compatible theme tokens instead of fixed Catppuccin
 * values. SyntaxStyle objects are cached per active theme because native style
 * instances are immutable after creation.
 *
 * The same style highlights source blocks: it carries the tree-sitter scopes
 * the bundled javascript/typescript grammars emit, so a fenced block in a
 * markdown document and a `<code filetype="javascript">` element both draw in
 * the active theme.
 */

import { SyntaxStyle } from "@opentui/core";
import { uiColors } from "../theme/colors";
import { getActiveThemeName } from "../theme/theme";

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

		// Source in a fenced block or a code element — the scopes the bundled
		// javascript/typescript grammars emit. A subtoken (`function.method`)
		// resolves to its base name, so one entry covers the family.
		{
			scope: ["keyword"],
			style: { foreground: uiColors.primary, bold: true },
		},
		{
			scope: ["string"],
			style: { foreground: uiColors.success },
		},
		{
			scope: ["comment"],
			style: { foreground: uiColors.textMuted, italic: true },
		},
		{
			scope: ["number"],
			style: { foreground: uiColors.highlight },
		},
		{
			scope: ["constant"],
			style: { foreground: uiColors.highlight },
		},
		{
			scope: ["constructor"],
			style: { foreground: uiColors.primaryDim },
		},
		{
			scope: ["function"],
			style: { foreground: uiColors.accent },
		},
		{
			scope: ["variable"],
			style: { foreground: uiColors.textPrimary },
		},
		{
			scope: ["property"],
			style: { foreground: uiColors.info },
		},
		{
			scope: ["operator"],
			style: { foreground: uiColors.textSecondary },
		},
		{
			scope: ["punctuation"],
			style: { foreground: uiColors.textSecondary },
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
