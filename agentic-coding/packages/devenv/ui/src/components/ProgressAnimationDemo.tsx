/** @jsxImportSource @opentui/solid */
import { useTimeline } from "@opentui/solid";
import { createSignal, For } from "solid-js";
import { uiColors } from "../colors";
import {
	AnimatedStatusText,
	type StatusAnimationIntent,
	statusAnimationModel,
} from "./AnimatedStatusText";
import { Badge } from "./Badge";
import {
	InlineProgressAnimation,
	type InlineProgressHighlights,
} from "./InlineProgressAnimation";
import { TextTransitionAnimation } from "./TextTransitionAnimation";

const palettes: Array<{ name: string; highlights: InlineProgressHighlights }> =
	[
		{ name: "Candy", highlights: ["highlight1", "highlight2", "highlight3"] },
		{ name: "Ocean", highlights: ["highlight2", "highlight3", "primary"] },
		{ name: "Dusk", highlights: ["highlight1", "secondary", "highlight3"] },
		{ name: "Neon", highlights: ["highlight3", "highlight2", "highlight1"] },
		{ name: "Neutral", highlights: ["highlight1", "primary", "highlight3"] },
		{ name: "Twilight", highlights: ["secondary", "highlight1", "highlight2"] },
	];

const statusExamples: Array<{ intent: StatusAnimationIntent; text: string }> = [
	{ intent: "start", text: "Starting service" },
	{ intent: "stop", text: "Stopping service" },
	{ intent: "build", text: "Building image" },
	{ intent: "test", text: "Running tests" },
	{ intent: "sync", text: "Checking out" },
	{ intent: "load", text: "Loading data" },
	{ intent: "ai", text: "Reviewing changes" },
	{ intent: "script", text: "Running task" },
];
const statusRows = [
	statusExamples.slice(0, 2),
	statusExamples.slice(2, 4),
	statusExamples.slice(4, 6),
	statusExamples.slice(6, 8),
];

function WipingAppearanceBadge() {
	const [badged, setBadged] = createSignal(false);
	const timeline = useTimeline({ duration: 2600, loop: true });
	timeline.call(() => setBadged((value) => !value), 1300);
	return (
		<Badge
			text="Ready"
			appearance={badged() ? "badge" : "text"}
			highlight="positive"
		/>
	);
}

export const PROGRESS_ANIMATION_DEMO_LINES = 15;

export function ProgressAnimationDemo() {
	return (
		<box
			backgroundColor={uiColors.bgSurface1}
			style={{
				width: "100%",
				height: PROGRESS_ANIMATION_DEMO_LINES,
				flexDirection: "column",
				paddingLeft: 1,
				flexShrink: 0,
			}}
		>
			<box style={{ width: "100%", height: 7, flexDirection: "row" }}>
				<box style={{ width: "65%", height: "100%", flexDirection: "column" }}>
					<text fg={uiColors.textSecondary}>
						Aurora text · Highlight color order
					</text>
					<For each={palettes}>
						{(palette) => (
							<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
								<box style={{ width: 9 }}>
									<text fg={uiColors.textMuted}>{palette.name}</text>
								</box>
								<InlineProgressAnimation
									text="Build"
									highlights={palette.highlights}
									backgroundColor={uiColors.bgSurface1}
								/>
								<text
									fg={uiColors.textMuted}
								>{`  ${palette.highlights.join(" → ")}`}</text>
							</box>
						)}
					</For>
				</box>

				<box style={{ width: "35%", height: "100%", flexDirection: "column" }}>
					<text fg={uiColors.textSecondary}>Aurora rounded badges</text>
					<For each={palettes}>
						{(palette) => (
							<Badge
								text={palette.name}
								animatedHighlights={palette.highlights}
							/>
						)}
					</For>
				</box>
			</box>

			<text fg={uiColors.textSecondary}>Operation status color model</text>
			<For each={statusRows}>
				{(row) => (
					<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
						<For each={row}>
							{(example) => (
								<box style={{ width: "50%", height: 1, flexDirection: "row" }}>
									<box style={{ width: 30 }}>
										<text fg={uiColors.textMuted}>
											{statusAnimationModel(example.intent).label}
										</text>
									</box>
									<AnimatedStatusText
										text={example.text}
										intent={example.intent}
										backgroundColor={uiColors.bgSurface1}
									/>
								</box>
							)}
						</For>
					</box>
				)}
			</For>

			<text fg={uiColors.textSecondary}>Wipe transitions</text>
			<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
				<box style={{ width: 12 }}>
					<text fg={uiColors.textMuted}>Text status</text>
				</box>
				<TextTransitionAnimation
					from="Starting"
					to="Running"
					fromHighlight="warning"
					toHighlight="positive"
					backgroundColor={uiColors.bgSurface1}
				/>
			</box>
			<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
				<box style={{ width: 12 }}>
					<text fg={uiColors.textMuted}>Text → badge</text>
				</box>
				<WipingAppearanceBadge />
			</box>
		</box>
	);
}
