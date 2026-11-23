/** @jsxImportSource @opentui/solid */

import type { BadgeTone } from "../catalog.ts";
import type { Theme } from "../opencode-types.ts";

export function toneColor(theme: Theme, tone: BadgeTone) {
	if (tone === "success") return theme.text.feedback.success.base;
	if (tone === "error") return theme.text.feedback.error.base;
	if (tone === "warning") return theme.text.feedback.warning.base;
	return theme.text.muted;
}

export function Badge(props: { theme: Theme; label: string; tone: BadgeTone }) {
	return (
		<text
			fg={toneColor(props.theme, props.tone)}
			wrapMode="none"
			flexShrink={0}
		>
			{props.label}
		</text>
	);
}
