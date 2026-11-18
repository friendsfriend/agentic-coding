/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Card } from "../presentation/components/Card.tsx";
import { HelpText } from "../presentation/components/HelpText.tsx";
import { ReadOnlyModalFrame } from "../presentation/components/ReadOnlyModalFrame.tsx";
import { useTerminalDimensions } from "../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../presentation/theme/colors.ts";

export type OrchestratorProfileChoice = {
	id: string;
	detail: string;
};

const ROW_HEIGHT = 2;
const CHROME_ROWS = 6;

/** The profile one orchestrator runs with. Choosing here is a developer decision
 * that sticks to that conversation; the configured default applies to the ones
 * nobody chose for. */
export function OrchestratorProfilePicker(props: {
	title: string;
	/** The profile it runs with now, marked in the list. */
	current: string;
	profiles: () => OrchestratorProfileChoice[];
	choose: (profile: string) => void;
	pending: () => boolean;
	close: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const [index, setIndex] = createSignal(
		Math.max(
			0,
			props.profiles().findIndex((entry) => entry.id === props.current),
		),
	);
	let disposed = false;
	const enabled = () => !disposed && !props.pending();
	const rows = createMemo(() => props.profiles());
	const framedHeight = () =>
		Math.max(
			8,
			Math.min(dimensions().height - 2, Math.round(dimensions().height * 0.5)),
		);
	const visible = () =>
		Math.max(1, Math.floor((framedHeight() - CHROME_ROWS) / ROW_HEIGHT));
	const listing = createMemo(() => {
		const count = rows().length;
		const size = Math.min(visible(), count);
		const start = Math.max(0, Math.min(count - size, index() - size + 1));
		return { start, size };
	});
	const visibleRows = createMemo(() =>
		rows().slice(listing().start, listing().start + listing().size),
	);
	const move = (delta: number) => {
		const total = rows().length;
		if (!total) return;
		setIndex((value) => Math.max(0, Math.min(total - 1, value + delta)));
	};
	const choose = (profile: string | undefined) => {
		if (!enabled() || !profile) return;
		props.choose(profile);
	};
	const unregister = useKeymap().registerLayer({
		priority: 192,
		enabled,
		commands: [],
		bindings: [
			{ key: "j", cmd: () => move(1) },
			{ key: "down", cmd: () => move(1) },
			{ key: "k", cmd: () => move(-1) },
			{ key: "up", cmd: () => move(-1) },
			{
				key: "return",
				cmd: () => choose(rows()[index()]?.id),
			},
			{ key: "escape", cmd: () => props.close() },
		],
	});
	onCleanup(() => {
		disposed = true;
		unregister();
	});
	return (
		<ReadOnlyModalFrame
			width={Math.max(36, Math.min(dimensions().width - 2, 84))}
			height={framedHeight()}
			active={enabled()}
			close={props.close}
			footerHeight={1}
			header={
				<box flexDirection="column" width="100%" flexShrink={0}>
					<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
						{`Profile for ${props.title}`}
					</text>
					<text fg={uiColors.textMuted} truncate>
						{`now ${props.current || "none"} · sticks to this conversation`}
					</text>
				</box>
			}
			footer={
				<HelpText
					entries={[
						{ key: "Enter", action: "use profile" },
						{ key: "↑↓", action: "choose" },
						{ key: "Esc", action: "cancel" },
					]}
					activatable={() => true}
					onActivate={(entry) => {
						if (entry.key === "Enter") choose(rows()[index()]?.id);
						else props.close();
					}}
				/>
			}
		>
			<box flexGrow={1} flexDirection="column" width="100%" overflow="hidden">
				<Show
					when={visibleRows().length > 0}
					fallback={
						<box paddingLeft={1}>
							<text fg={uiColors.textMuted}>No profiles are configured.</text>
						</box>
					}
				>
					<For each={visibleRows()}>
						{(entry, position) => {
							const row = () => listing().start + position();
							return (
								<Card
									height={ROW_HEIGHT}
									selected={() => index() === row()}
									title={entry.id}
									cells={[
										<text fg={uiColors.textMuted}>
											{entry.detail}
											{entry.id === props.current ? " · current" : ""}
										</text>,
									]}
									onMouseUp={() => {
										setIndex(row());
										choose(entry.id);
									}}
									onActivate={() => {
										setIndex(row());
										choose(entry.id);
									}}
								/>
							);
						}}
					</For>
				</Show>
			</box>
		</ReadOnlyModalFrame>
	);
}
