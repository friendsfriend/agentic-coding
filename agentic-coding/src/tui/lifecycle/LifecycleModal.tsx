/** @jsxImportSource @opentui/solid */
// Full-terminal lifecycle overlay: startup ("Starting server…") and shutdown
// ("Stopping server…") progress. Portal-anchored at the renderer root (same
// pattern as dash/ui/GenericModal.tsx) so it covers the terminal regardless of
// the active tab. Renders nothing when the lifecycle phase is idle/running.
import { RGBA, TextAttributes } from "@opentui/core";
import { Portal, useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import { colors, uiColors } from "../dash/ui/colors";
import { message, phase, steps } from "../lifecycle";

const mixHex = (from: string, to: string, amount: number) => {
	const channel = (hex: string, offset: number) =>
		parseInt(hex.slice(offset, offset + 2), 16);
	const mixed = [1, 3, 5].map((offset) =>
		Math.round(
			channel(from, offset) +
				(channel(to, offset) - channel(from, offset)) * amount,
		),
	);
	return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};
const progressColor = (position: number) =>
	position < 0.5
		? mixHex(colors.blue, colors.lavender, position * 2)
		: mixHex(colors.lavender, colors.green, (position - 0.5) * 2);

const GLYPHS: Record<string, string> = {
	pending: "·",
	active: "▸",
	done: "✓",
	error: "✗",
};
const stepColor = (status: string) =>
	status === "error"
		? uiColors.error
		: status === "done"
			? uiColors.success
			: status === "active"
				? uiColors.primary
				: uiColors.textMuted;

export function LifecycleModal() {
	const dimensions = useTerminalDimensions();
	const visible = createMemo(
		() => phase() === "starting" || phase() === "stopping",
	);
	const title = createMemo(() =>
		phase() === "starting" ? "Starting server…" : "Stopping server…",
	);
	const doneCount = createMemo(
		() =>
			steps().filter(
				(step) => step.status === "done" || step.status === "error",
			).length,
	);
	const progressWidth = () => Math.max(1, Math.floor(dimensions().width * 0.5));
	const [animatedProgress, setAnimatedProgress] = createSignal(0);
	let progressTimer: ReturnType<typeof setInterval> | undefined;
	createEffect(() => {
		clearInterval(progressTimer);
		if (!visible()) return;
		const target =
			(progressWidth() * doneCount()) / Math.max(1, steps().length);
		const startedAt = Date.now();
		progressTimer = setInterval(() => {
			const elapsed = Math.min(1, (Date.now() - startedAt) / 320);
			const eased = 1 - (1 - elapsed) ** 3;
			setAnimatedProgress(target * eased);
			if (elapsed === 1) clearInterval(progressTimer);
		}, 16);
	});
	onCleanup(() => clearInterval(progressTimer));
	const progressEnd = () =>
		Math.min(progressWidth() - 1, Math.floor(animatedProgress()));

	return (
		<Show when={visible()}>
			<Portal
				ref={(el) => {
					(el as { position?: string }).position = "absolute";
				}}
			>
				<box
					position="absolute"
					top={0}
					left={0}
					width={dimensions().width}
					height={dimensions().height}
					flexDirection="column"
					justifyContent="center"
					alignItems="center"
					backgroundColor={RGBA.fromValues(0, 0, 0, 0.35)}
				>
					<box
						backgroundColor={uiColors.bgMantle}
						width={Math.max(40, Math.floor(dimensions().width * 0.5))}
						flexDirection="column"
						paddingTop={1}
						paddingBottom={1}
						paddingLeft={2}
						paddingRight={2}
					>
						<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
							{title()}
						</text>
						<box width="100%" height={1}>
							<text>
								<For
									each={Array.from(
										{ length: progressWidth() },
										(_, index) => index,
									)}
								>
									{(index) => (
										<span
											style={{
												fg:
													index < progressEnd()
														? progressColor(
																index / Math.max(1, progressWidth() - 1),
															)
														: uiColors.textMuted,
											}}
										>
											{index < progressEnd() ? "━" : "─"}
										</span>
									)}
								</For>
							</text>
						</box>
						<For each={steps()}>
							{(step) => (
								<box height={1} flexDirection="row">
									<text fg={stepColor(step.status)}>{GLYPHS[step.status]}</text>
									<text
										fg={
											step.status === "error"
												? uiColors.error
												: uiColors.textPrimary
										}
									>
										{" "}
										{step.label}
									</text>
								</box>
							)}
						</For>
						<Show when={message() !== ""}>
							<text fg={uiColors.error}>{message()}</text>
						</Show>
					</box>
				</box>
			</Portal>
		</Show>
	);
}
