/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, onMount } from "solid-js";
import type { Theme } from "../opencode-types.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner(props: { theme: Theme; label: string }) {
	const [frame, setFrame] = createSignal(0);
	onMount(() => {
		const timer = setInterval(
			() => setFrame((current) => (current + 1) % FRAMES.length),
			120,
		);
		onCleanup(() => clearInterval(timer));
	});
	return (
		<text fg={props.theme.text.muted} wrapMode="word">
			<span style={{ fg: props.theme.text.feedback.warning.base }}>
				{FRAMES[frame()]}
			</span>{" "}
			{props.label}
		</text>
	);
}
