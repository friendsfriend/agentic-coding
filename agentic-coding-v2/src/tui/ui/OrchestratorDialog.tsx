/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createSignal, onCleanup } from "solid-js";
import { HelpText } from "../presentation/components/HelpText.tsx";
import { ReadOnlyModalFrame } from "../presentation/components/ReadOnlyModalFrame.tsx";
import { SearchHeader } from "../presentation/components/SearchHeader.tsx";
import { useTerminalDimensions } from "../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../presentation/theme/colors.ts";

const TITLE_KEYS = `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:/+@ ()[]`;

/** One local dialog for the two things the shell may do to an orchestrator it
 * created: rename it, or close it. Closing ends the session — it leaves the
 * sidebar, refuses input and keeps its transcript on disk — and it is not
 * deletion, so the dialog says what the developer loses and what they must do
 * next instead of implying removal. */
export function OrchestratorDialog(props: {
	target: { id: number; title: string };
	mode: "rename" | "close";
	/** A boundary call is in flight; keys are inert until the host answers. */
	pending: () => boolean;
	rename: (input: { id: number; title: string }) => void;
	closeSession: (input: { id: number }) => void;
	close: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const [title, setTitle] = createSignal(props.target.title);
	let disposed = false;
	const enabled = () => !disposed && !props.pending();
	const rename = () => {
		if (!enabled()) return;
		const next = title().trim();
		if (!next) return;
		props.rename({ id: props.target.id, title: next });
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.orchestratorDialog",
		priority: 192,
		enabled,
		commands: [],
		bindings: [
			{ key: "escape", cmd: () => props.close() },
			...(props.mode === "rename"
				? [
						{ key: "return", cmd: rename },
						{ key: "backspace", cmd: () => setTitle((v) => v.slice(0, -1)) },
						{ key: "ctrl+u", cmd: () => setTitle("") },
						...TITLE_KEYS.split("").map((key) => ({
							key,
							cmd: () => setTitle((v) => (v + key).slice(0, 120)),
						})),
						{ key: "space", cmd: () => setTitle((v) => `${v} `.slice(0, 120)) },
					]
				: [
						{
							key: "y",
							cmd: () =>
								enabled() && props.closeSession({ id: props.target.id }),
						},
						{ key: "n", cmd: () => props.close() },
					]),
		],
	});
	onCleanup(() => {
		disposed = true;
		unregister();
	});
	return (
		<ReadOnlyModalFrame
			width={Math.max(30, Math.min(dimensions().width - 2, 72))}
			height={Math.max(9, Math.min(13, dimensions().height))}
			active={enabled()}
			close={props.close}
			footerHeight={1}
			header={
				<SearchHeader>
					<text
						fg={
							props.mode === "close" ? uiColors.warning : uiColors.textPrimary
						}
						attributes={TextAttributes.BOLD}
					>
						{props.mode === "close"
							? `⚠ Close ${props.target.title}?`
							: `Rename ${props.target.title}`}
					</text>
				</SearchHeader>
			}
			footer={
				<HelpText
					entries={
						props.mode === "close"
							? [
									{ key: "y", action: "close" },
									{ key: "n", action: "keep" },
									{ key: "Esc", action: "keep" },
								]
							: [
									{ key: "Enter", action: "rename" },
									{ key: "Esc", action: "cancel" },
								]
					}
					activatable={() => true}
					onActivate={(entry) => {
						if (props.mode === "close") {
							if (entry.key === "y")
								props.closeSession({ id: props.target.id });
							else props.close();
						} else if (entry.key === "Enter") rename();
						else props.close();
					}}
				/>
			}
		>
			<box flexDirection="column" width="100%" gap={1}>
				{props.mode === "close" ? (
					<text fg={uiColors.textMuted} wrapMode="word">
						The session ends and leaves the sidebar: nothing can be asked,
						reported or sent to it again. Its transcript stays on disk, and a
						new orchestrator must be created to continue work in this checkout.
						Running work it asked for is stopped. This cannot be undone.
					</text>
				) : (
					<box height={1} flexDirection="row" overflow="hidden">
						<text fg={uiColors.textMuted}>{"title "}</text>
						<text fg={uiColors.textPrimary} truncate>
							{title()}
						</text>
						<text fg={uiColors.primary}>▌</text>
					</box>
				)}
			</box>
		</ReadOnlyModalFrame>
	);
}
