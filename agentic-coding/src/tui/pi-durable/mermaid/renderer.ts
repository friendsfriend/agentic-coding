import { uiColors } from "@agentic-coding/ui";
import type { RenderContext } from "@opentui/core";
import { createMermaidMarkdownRenderer } from "./vendor/markdown.ts";

/** Per-message hook: diagram caches cannot outlive their transcript renderables. */
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
