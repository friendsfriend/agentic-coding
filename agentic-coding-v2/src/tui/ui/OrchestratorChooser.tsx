/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Card } from "../presentation/components/Card.tsx";
import { HelpText } from "../presentation/components/HelpText.tsx";
import { ReadOnlyModalFrame } from "../presentation/components/ReadOnlyModalFrame.tsx";
import { useTerminalDimensions } from "../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../presentation/theme/colors.ts";

/** One configured checkout the developer may start an orchestrator in. */
export type ConfiguredCheckout = {
	id: string;
	kind: string;
	repository: string;
};

const ROW_HEIGHT = 2;
const CHROME_ROWS = 7;
/** Everything a printable key can type into an absolute path. */
const PATH_KEYS = `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~@+=`;
const name = (value: string) => value.split("/").filter(Boolean).at(-1) ?? "";
/** A path as typed, without a trailing separator, for comparison only. */
const settled = (value: string) =>
	value.length > 1 ? value.replace(/\/+$/, "") : value;

/** The `+` chooser: where a new orchestrator works. The path is bound exactly as
 * given — no worktree, clone, branch or discovery — and a configured checkout
 * binds that directory. Nothing is created until the host accepts it. */
export function OrchestratorChooser(props: {
	/** The shell's own directory: the custom row starts here, editable. */
	initialPath: string;
	configured: () => ConfiguredCheckout[];
	/** Orchestrators that already exist, so a directory in use is visible before
	 * it is chosen again. A duplicate is allowed: a path is the agent's working
	 * directory, not a lock, and this only says so. The comparison is textual —
	 * the host is the authority on what a path resolves to. */
	existing: () => { title: string; path: string }[];
	/** The shell reports refusal and navigates on success; this only submits.
	 * The creation identity is stable per target, so a retried submission cannot
	 * create a second orchestrator for the same intent. */
	create: (input: { path: string; title: string; requestId: string }) => void;
	/** A creation is in flight; keys are inert until the host answers. */
	pending: () => boolean;
	close: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const [target, setTarget] = createSignal(props.initialPath);
	const [index, setIndex] = createSignal(0);
	let disposed = false;
	const enabled = () => !disposed && !props.pending();
	// Row 0 is the typed path; then one row per configured checkout, in the
	// order the host reports them.
	const rows = createMemo(() => [
		{ path: target(), title: name(target()) || "Orchestrator" },
		...props.configured().map((entry) => ({
			path: entry.repository,
			title: entry.id,
		})),
	]);
	/** Who already works in this directory, if anyone. */
	const inUse = (path: string) =>
		props
			.existing()
			.filter((entry) => settled(entry.path) === settled(path.trim()));
	const customInUse = createMemo(() => inUse(target()));
	const framedHeight = () =>
		Math.max(
			10,
			Math.min(dimensions().height - 2, Math.round(dimensions().height * 0.6)),
		);
	const visible = () =>
		Math.max(1, Math.floor((framedHeight() - CHROME_ROWS) / ROW_HEIGHT));
	const listing = createMemo(() => {
		const count = rows().length;
		const size = Math.min(visible(), count);
		const start = Math.max(0, Math.min(count - size, index() - size + 1));
		return { start, size };
	});
	// Row 0 is the typed path, so a configured row's index is its own position
	// plus the offset of the window inside `rows()` — never the window start
	// itself, which would mark row 0 as both the typed path and the first
	// checkout.
	const configuredOffset = () => Math.max(0, listing().start - 1);
	const configuredRows = createMemo(() =>
		rows()
			.slice(1)
			.slice(
				configuredOffset(),
				configuredOffset() + listing().size - (listing().start === 0 ? 1 : 0),
			),
	);
	const customVisible = () => listing().start === 0;
	const rowIndex = (position: number) => 1 + configuredOffset() + position;
	const move = (delta: number) => {
		const total = rows().length;
		if (!total) return;
		setIndex((value) => Math.max(0, Math.min(total - 1, value + delta)));
	};
	const edit = (text: string) => {
		setTarget((value) => (value + text).slice(0, 4096));
		// Typing is about the path, so the custom row is the one Enter acts on.
		setIndex(0);
	};
	// One identity per target: typing changes it, retrying the same target does
	// not, and the host answers a replay with the orchestrator it already made.
	let submitted: { key: string; id: string } | null = null;
	const submit = () => {
		const choice = rows()[index()];
		if (!choice || !enabled()) return;
		const key = `${choice.path}\u0000${choice.title}`;
		if (submitted?.key !== key) submitted = { key, id: crypto.randomUUID() };
		props.create({ ...choice, requestId: submitted.id });
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.orchestratorChooser",
		priority: 186,
		enabled,
		commands: [],
		bindings: [
			{ key: "up", cmd: () => move(-1) },
			{ key: "down", cmd: () => move(1) },
			{ key: "tab", cmd: () => move(1) },
			{ key: "return", cmd: submit },
			{ key: "escape", cmd: () => props.close() },
			{ key: "backspace", cmd: () => setTarget((value) => value.slice(0, -1)) },
			{ key: "ctrl+u", cmd: () => setTarget("") },
			...PATH_KEYS.split("").map((key) => ({ key, cmd: () => edit(key) })),
			// "/" is the character a keyboard sends, not a name like "slash":
			// binding the name silently dropped every separator, and an absolute
			// path could not be typed at all.
			{ key: "/", cmd: () => edit("/") },
			{ key: "space", cmd: () => edit(" ") },
		],
	});
	onCleanup(() => {
		disposed = true;
		unregister();
	});
	return (
		<ReadOnlyModalFrame
			width={Math.max(
				40,
				Math.min(dimensions().width - 2, Math.round(dimensions().width * 0.7)),
			)}
			height={framedHeight()}
			active={enabled()}
			close={props.close}
			footerHeight={1}
			header={
				<box flexDirection="column" width="100%" flexShrink={0}>
					<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
						New orchestrator
					</text>
					<box height={1} flexDirection="row" overflow="hidden">
						<text fg={uiColors.textMuted}>{"path "}</text>
						<text fg={uiColors.textPrimary} truncate>
							{target()}
						</text>
						<text fg={uiColors.primary}>▌</text>
					</box>
					<Show when={customInUse().length > 0}>
						<box height={1} flexDirection="row" overflow="hidden">
							<text fg={uiColors.textMuted} truncate>
								{`already ${customInUse().length === 1 ? `"${customInUse()[0]?.title}"` : `${customInUse().length} orchestrators`} · a second is allowed`}
							</text>
						</box>
					</Show>
				</box>
			}
			footer={
				<HelpText
					entries={[
						{ key: "Enter", action: "start" },
						{ key: "↑↓", action: "choose checkout" },
						{ key: "Esc", action: "cancel" },
					]}
					activatable={() => true}
					onActivate={(entry) => {
						if (entry.key === "Enter") submit();
						else if (entry.key === "Esc") props.close();
					}}
				/>
			}
		>
			<box flexGrow={1} flexDirection="column" width="100%" overflow="hidden">
				<Show when={customVisible()}>
					<Card
						height={ROW_HEIGHT}
						selected={() => index() === 0}
						title={rows()[0]?.title ?? "Orchestrator"}
						cells={[
							<text fg={uiColors.textMuted}>
								{props.initialPath === target()
									? "shell directory"
									: "typed path"}{" "}
								· {target()}
							</text>,
						]}
						onMouseUp={() => {
							setIndex(0);
							submit();
						}}
						onActivate={() => {
							setIndex(0);
							submit();
						}}
					/>
				</Show>
				<Show when={configuredRows().length > 0}>
					<box height={1} flexShrink={0} paddingLeft={2}>
						<text fg={uiColors.textMuted}>Configured checkouts</text>
					</box>
					<For each={configuredRows()}>
						{(entry, position) => {
							const row = () => rowIndex(position());
							return (
								<Card
									height={ROW_HEIGHT}
									selected={() => index() === row()}
									title={entry.title}
									cells={[
										<text fg={uiColors.textMuted}>
											{`${entry.path}${inUse(entry.path).length > 0 ? " · in use" : ""}`}
										</text>,
									]}
									onMouseUp={() => {
										setIndex(row());
										submit();
									}}
									onActivate={() => {
										setIndex(row());
										submit();
									}}
								/>
							);
						}}
					</For>
				</Show>
				<Show when={props.configured().length === 0}>
					<box paddingLeft={2} flexShrink={0}>
						<text fg={uiColors.textMuted}>
							No configured applications or libraries.
						</text>
					</box>
				</Show>
			</box>
		</ReadOnlyModalFrame>
	);
}
