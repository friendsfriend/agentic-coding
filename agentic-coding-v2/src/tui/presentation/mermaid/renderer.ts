import type { RenderContext } from "@opentui/core";
import { uiColors } from "../theme/colors.ts";
import { createMermaidMarkdownRenderer } from "./vendor/markdown.ts";

/** Vendored upstream Mermaid terminal renderer (MIT, see vendor/LICENSE).
 * Palette binding is the only local change: it reads the live theme, so a theme
 * change restyles the next prepared diagram. Diagrams render fenced Mermaid
 * source from the transcript; they never fetch, execute or resolve a link. Every
 * diagram is scoped to the Markdown renderable that claimed it. */
export function createSessionMermaidRenderer(ctx: RenderContext) {
	return createMermaidMarkdownRenderer(ctx, () => ({
		colors: {
			text: uiColors.textPrimary,
			primary: uiColors.textPrimary,
			secondary: uiColors.textSecondary,
			muted: uiColors.textMuted,
			background: uiColors.bgBase,
			boxText: uiColors.textPrimary,
			boxBorder: uiColors.textMuted,
			line: uiColors.textSecondary,
			group: uiColors.accent,
			groupText: uiColors.accent,
			request: uiColors.success,
			response: uiColors.warning,
			warning: uiColors.warning,
		},
	}));
}
