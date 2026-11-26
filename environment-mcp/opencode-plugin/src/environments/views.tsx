/** @jsxImportSource @opentui/solid */
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	Match,
	onMount,
	Show,
	Switch,
	untrack,
} from "solid-js";
import { formatTelemetryResult } from "../../../src/ui/telemetry-format.ts";
import type { Context, PanelInput, Theme } from "../opencode-types.ts";
import {
	type BuildOutput,
	buildStepIcon,
	buildStepTone,
	mergeBuildOutput,
	parseBuildOutput,
} from "./build.ts";
import { footerKeybinds, HELP_SECTIONS, type HelpSection } from "./keybinds.ts";
import { providerMarkdown } from "./markdown.ts";
import {
	actionGlyph,
	type ConfigurationMutationResult,
	type ConfigurationPreview,
	type ContainerStatsEntry,
	type ContainerStatsResult,
	type EnvironmentApp,
	type EnvironmentService,
	type EnvironmentStatus,
	type EnvironmentTarget,
	type EnvironmentView,
	type ExecutionReceipt,
	filterApps,
	formatTimestamp,
	type GitActionOutcome,
	type GitBranch,
	type GitChange,
	type GitChanges,
	type GitDiff,
	type GitRemotes,
	type GitStashes,
	type GitStatus,
	type GitTags,
	type GitWorktrees,
	type GitWriteOutcome,
	type GitWriteRequest,
	type KubernetesClusterInfo,
	type KubernetesDescribe,
	type KubernetesEvent,
	type KubernetesEvents,
	type KubernetesPodLogs,
	type KubernetesResources,
	type LogsSnapshot,
	type OperationDetail,
	type OperationSubject,
	type OperationSummary,
	type OwnedResource,
	ownedFor,
	type ProviderChange,
	type ProviderChangeDetail,
	type ProviderDiscussion,
	type ProviderFile,
	type ProviderFiles,
	type ProviderIssue,
	type ProviderIssueDetail,
	type ProviderJob,
	type ProviderJobLogs,
	type ProviderPipeline,
	type ProviderRepository,
	type ProviderSummary,
	type ProviderVersion,
	type ProviderWriteAction,
	type ProviderWriteReceipt,
	prettyJson,
	receiptText,
	scopeLabel,
	shortId,
	type TelemetrySnapshot,
	type TelemetryTrace,
	targetLabel,
	targetSummary,
} from "./model.ts";
import { filetypeFor, useSyntaxStyle } from "./syntax.ts";

function toneColor(
	theme: Theme,
	tone: "success" | "error" | "warning" | "muted" | "info" | "normal",
) {
	if (tone === "success") return theme.text.feedback.success.base;
	if (tone === "error") return theme.text.feedback.error.base;
	if (tone === "warning") return theme.text.feedback.warning.base;
	if (tone === "info") return theme.text.feedback.info.base;
	if (tone === "muted") return theme.text.muted;
	return theme.text.base;
}

function Badge(props: {
	theme: Theme;
	label: string;
	tone: "success" | "error" | "warning" | "muted" | "info";
}) {
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

function Section(props: {
	theme: Theme;
	title: string;
	right?: string;
	children: JSX.Element;
	grow?: boolean;
}) {
	return (
		<box
			flexDirection="column"
			backgroundColor={props.theme.background.raised.base}
		>
			<box
				flexDirection="row"
				paddingLeft={1}
				paddingRight={1}
				height={1}
				flexShrink={0}
			>
				<text fg={props.theme.text.feedback.info.base} wrapMode="none">
					<b>{props.title}</b>
				</text>
				<box flexGrow={1} />
				<Show when={props.right}>
					<text fg={props.theme.text.muted} wrapMode="none">
						{props.right}
					</text>
				</Show>
			</box>
			<box
				border={["left"]}
				borderColor={props.theme.border.base}
				flexDirection="column"
				paddingLeft={1}
				paddingRight={1}
				flexGrow={props.grow ? 1 : 0}
				flexShrink={0}
				minHeight={0}
			>
				{props.children}
			</box>
		</box>
	);
}

function Property(props: {
	theme: Theme;
	label: string;
	value: string;
	tone?: "success" | "error" | "warning" | "muted" | "info" | "normal";
	labelWidth?: number;
}) {
	return (
		<box flexDirection="row" gap={1} minWidth={0} height={1}>
			<text
				fg={props.theme.text.muted}
				width={props.labelWidth ?? 14}
				flexShrink={0}
				wrapMode="none"
			>
				{props.label}
			</text>
			<text
				fg={toneColor(props.theme, props.tone ?? "normal")}
				wrapMode="none"
				truncate
				flexGrow={1}
				minWidth={0}
			>
				{props.value}
			</text>
		</box>
	);
}

function actionLabel(action?: string) {
	if (action === "build") return "building";
	if (action === "test") return "testing";
	if (action === "run") return "starting";
	return "working";
}

function appStatus(owned: number, active?: { action?: string }) {
	if (owned > 0)
		return {
			label: "running",
			tone: "success" as const,
			detail: `${owned} owned`,
		};
	if (active)
		return {
			label: actionLabel(active.action),
			tone: "warning" as const,
			detail: "in progress",
		};
	return { label: "stopped", tone: "muted" as const, detail: "—" };
}

function GitBadges(props: { theme: Theme; status?: GitStatus }) {
	const current = () => props.status;
	const sync = () => {
		const value = current();
		if (!value) return "";
		return [
			value.ahead > 0 ? `↑${value.ahead}` : "",
			value.behind > 0 ? `↓${value.behind}` : "",
		]
			.filter(Boolean)
			.join(" ");
	};
	return (
		<box flexDirection="row" gap={1} minWidth={0}>
			<Show when={!current() || current()?.state === "unknown"}>
				<text fg={props.theme.text.muted} wrapMode="none">
					{current() ? "unavailable" : "—"}
				</text>
			</Show>
			<Show when={current()?.state === "clean"}>
				<text fg={props.theme.text.feedback.success.base} wrapMode="none">
					clean
				</text>
			</Show>
			<Show when={(current()?.modified ?? 0) > 0}>
				<text fg={props.theme.text.feedback.warning.base} wrapMode="none">
					~{String(current()?.modified)}
				</text>
			</Show>
			<Show when={(current()?.added ?? 0) > 0}>
				<text fg={props.theme.text.feedback.success.base} wrapMode="none">
					+{String(current()?.added)}
				</text>
			</Show>
			<Show when={(current()?.deleted ?? 0) > 0}>
				<text fg={props.theme.text.feedback.error.base} wrapMode="none">
					-{String(current()?.deleted)}
				</text>
			</Show>
			<Show when={sync()}>
				<text fg={props.theme.text.muted} wrapMode="none">
					{sync()}
				</text>
			</Show>
		</box>
	);
}

export function AppTable(props: {
	theme: Theme;
	apps: readonly EnvironmentApp[];
	owned: readonly OwnedResource[];
	git: ReadonlyMap<string, GitStatus>;
	active: ReadonlyMap<string, { action?: string }>;
	worktree?: string;
	selected: number;
	query: string;
	searchFocused: boolean;
	compact: boolean;
	onQuery(value: string): void;
	onSelect(index: number): void;
	onOpen(): void;
	onSearchSubmit(): void;
	onSearchRef(input: InputRenderable | undefined): void;
	onFocusSearch(): void;
	onBlurSearch(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const ownedCounts = createMemo(() => {
		const counts = new Map<string, number>();
		for (const resource of props.owned)
			counts.set(resource.app, (counts.get(resource.app) ?? 0) + 1);
		return counts;
	});
	const visible = createMemo(() => filterApps(props.apps, props.query));

	createEffect(() => {
		const app = visible()[props.selected];
		if (!scroll || !app) return;
		queueMicrotask(() => scroll?.scrollChildIntoView(`app-${app.id}`));
	});

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<box
				flexDirection="column"
				paddingLeft={2}
				paddingRight={2}
				paddingBottom={1}
				gap={1}
				flexShrink={0}
			>
				<box flexDirection="row" gap={1} height={1}>
					<text fg={props.theme.text.muted} flexShrink={0}>
						/
					</text>
					<input
						ref={(value: InputRenderable) => props.onSearchRef(value)}
						value={props.query}
						placeholder="filter applications, targets, repositories"
						focused={props.searchFocused}
						backgroundColor={props.theme.background.base}
						focusedBackgroundColor={props.theme.background.raised.base}
						textColor={props.theme.text.base}
						focusedTextColor={props.theme.text.base}
						placeholderColor={props.theme.text.muted}
						cursorColor={props.theme.text.base}
						onInput={props.onQuery}
						onSubmit={props.onSearchSubmit}
						on:focus={props.onFocusSearch}
						on:blur={props.onBlurSearch}
						flexGrow={1}
					/>
				</box>
			</box>
			<box
				flexDirection="row"
				gap={1}
				paddingLeft={2}
				paddingRight={2}
				height={1}
				flexShrink={0}
			>
				<text fg={props.theme.text.muted} flexGrow={1} wrapMode="none">
					Application
				</text>
				<text
					fg={props.theme.text.muted}
					width={props.compact ? "29%" : "20%"}
					wrapMode="none"
				>
					Targets
				</text>
				<Show when={!props.compact}>
					<text fg={props.theme.text.muted} width="15%" wrapMode="none">
						Git
					</text>
				</Show>
				<text
					fg={props.theme.text.muted}
					width={props.compact ? "14%" : "15%"}
					wrapMode="none"
				>
					Status
				</text>
			</box>
			<Show
				when={visible().length > 0}
				fallback={
					<box paddingLeft={2} paddingRight={2} paddingTop={1}>
						<text fg={props.theme.text.muted} wrapMode="word">
							{props.query.trim()
								? `No application matches “${props.query.trim()}”.`
								: "No applications in this tab."}
						</text>
					</box>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={visible()}>
						{(app, index) => {
							const selected = () => index() === props.selected;
							const owned = () => ownedCounts().get(app.id) ?? 0;
							const active = () => props.active.get(app.id);
							const currentGit = () => props.git.get(app.repository);
							const status = () => appStatus(owned(), active());
							const gitBranch = () => {
								const current = currentGit();
								if (current?.branch) return current.branch;
								if (current?.head) return `@${current.head}`;
								return "—";
							};
							return (
								<box
									id={`app-${app.id}`}
									flexDirection="column"
									paddingLeft={2}
									paddingRight={2}
									height={2}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<Show
										when={!props.compact}
										fallback={
											<>
												<box flexDirection="row" gap={1} minWidth={0}>
													<text
														fg={
															selected()
																? props.theme.text.action.primary.base
																: props.theme.text.muted
														}
														flexShrink={0}
													>
														{selected() ? "›" : " "}
													</text>
													<text
														fg={
															selected()
																? props.theme.text.action.primary.base
																: props.theme.text.base
														}
														wrapMode="none"
														truncate
														flexGrow={1}
														minWidth={0}
													>
														<b>{app.id}</b>
													</text>
													<text
														fg={toneColor(props.theme, status().tone)}
														wrapMode="none"
														flexShrink={0}
													>
														{status().label}
													</text>
												</box>
												<box
													flexDirection="row"
													gap={1}
													paddingLeft={2}
													minWidth={0}
												>
													<text
														fg={props.theme.text.muted}
														wrapMode="none"
														flexShrink={0}
													>
														{targetSummary(app) || "no targets"}
													</text>
													<text
														fg={props.theme.text.muted}
														wrapMode="none"
														flexShrink={0}
													>
														·
													</text>
													<GitBadges
														theme={props.theme}
														status={currentGit()}
													/>
													<text
														fg={
															selected()
																? props.theme.text.base
																: props.theme.text.muted
														}
														wrapMode="none"
														truncate
														flexGrow={1}
														minWidth={0}
													>
														{gitBranch()}
													</text>
												</box>
											</>
										}
									>
										<box flexDirection="row" gap={1} flexGrow={1} minWidth={0}>
											<box flexDirection="column" flexGrow={1} minWidth={0}>
												<box flexDirection="row" gap={1} minWidth={0}>
													<text
														fg={
															selected()
																? props.theme.text.action.primary.base
																: props.theme.text.muted
														}
														flexShrink={0}
													>
														{selected() ? "›" : " "}
													</text>
													<text
														fg={
															selected()
																? props.theme.text.action.primary.base
																: props.theme.text.base
														}
														wrapMode="none"
														truncate
														flexGrow={1}
														minWidth={0}
													>
														<b>{app.id}</b>
													</text>
												</box>
												<text
													fg={props.theme.text.muted}
													paddingLeft={2}
													wrapMode="none"
													truncate
												>
													{app.kind}
												</text>
											</box>
											<box flexDirection="column" width="20%" minWidth={0}>
												<text
													fg={props.theme.text.muted}
													wrapMode="none"
													truncate
												>
													{targetSummary(app) || "no targets"}
												</text>
												<text
													fg={props.theme.text.muted}
													wrapMode="none"
													truncate
												>
													{app.targets.length} configured
												</text>
											</box>
											<box flexDirection="column" width="15%" minWidth={0}>
												<GitBadges theme={props.theme} status={currentGit()} />
												<text
													fg={
														selected()
															? props.theme.text.base
															: props.theme.text.muted
													}
													wrapMode="none"
													truncate
												>
													{gitBranch()}
												</text>
											</box>
											<box flexDirection="column" width="15%" minWidth={0}>
												<text
													fg={toneColor(props.theme, status().tone)}
													wrapMode="none"
													truncate
												>
													{status().label}
												</text>
												<text
													fg={props.theme.text.muted}
													wrapMode="none"
													truncate
												>
													{status().detail}
												</text>
											</box>
										</box>
									</Show>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

function changeGlyph(kind: GitChange["kind"]) {
	if (kind === "added" || kind === "untracked") return "A";
	if (kind === "deleted") return "D";
	if (kind === "renamed") return "R";
	if (kind === "copied") return "C";
	if (kind === "conflicted") return "U";
	return "M";
}

function changeTone(
	kind: GitChange["kind"],
): "success" | "error" | "info" | "warning" {
	if (kind === "added" || kind === "untracked") return "success";
	if (kind === "deleted" || kind === "conflicted") return "error";
	if (kind === "renamed" || kind === "copied") return "info";
	return "warning";
}

export function ChangesView(props: {
	theme: Theme;
	app: EnvironmentApp;
	changes: GitChanges;
	selected: number;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedChange = () =>
		props.changes.changes[props.selected] ?? props.changes.changes[0];
	createEffect(() => {
		const change = selectedChange();
		if (!scroll || !change) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`change-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>Changes</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" truncate flexGrow={1}>
					{props.app.id}
				</text>
				<Show when={props.changes.truncated}>
					<Badge theme={props.theme} label="truncated" tone="warning" />
				</Show>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.changes.changes.length}
				</text>
				<text
					fg={props.theme.text.feedback.info.base}
					wrapMode="none"
					flexShrink={0}
				>
					{props.changes.changes.filter((change) => change.staged).length}{" "}
					staged
				</text>
			</box>
			<Show
				when={props.changes.changes.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.changes.note === "unavailable"
							? "Change list unavailable."
							: "No working-tree changes."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.changes.changes}>
						{(change, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`change-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text
										fg={toneColor(props.theme, changeTone(change.kind))}
										width={1}
										flexShrink={0}
									>
										{changeGlyph(change.kind)}
									</text>
									<text
										fg={
											selected()
												? props.theme.text.base
												: props.theme.text.muted
										}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{change.path}
									</text>
									<Show when={change.originalPath}>
										<text
											fg={props.theme.text.muted}
											wrapMode="none"
											truncate
											flexShrink={0}
										>
											← {change.originalPath}
										</text>
									</Show>
									<text
										fg={props.theme.text.muted}
										wrapMode="none"
										flexShrink={0}
									>
										{[
											change.staged ? "staged" : "",
											change.worktree ? "worktree" : "",
										]
											.filter(Boolean)
											.join(" · ")}
									</text>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function DiffView(props: {
	theme: Theme;
	app: EnvironmentApp;
	diff: GitDiff;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	onMount(() => queueMicrotask(() => scroll?.focus()));
	const body = () => {
		if (props.diff.note === "unavailable") return "Diff unavailable.";
		if (props.diff.binary) return "Binary file; no text diff.";
		if (props.diff.note === "symlink") return "Symbolic link; no text diff.";
		if (props.diff.note === "directory") return "Directory; no file diff.";
		if (props.diff.note === "invalid-path") return "Invalid path.";
		if (props.diff.note === "no-change") return "No diff for this path.";
		return props.diff.diff || "No diff for this path.";
	};
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>Diff</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" truncate flexGrow={1}>
					{props.app.id} · {props.diff.path}
				</text>
				<Badge theme={props.theme} label={props.diff.side} tone="info" />
				<Show when={props.diff.binary}>
					<Badge theme={props.theme} label="binary" tone="warning" />
				</Show>
				<Show when={props.diff.truncated}>
					<Badge theme={props.theme} label="truncated" tone="warning" />
				</Show>
			</box>
			<scrollbox
				ref={(value: ScrollBoxRenderable) => {
					scroll = value;
				}}
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<text
					fg={props.theme.text.base}
					wrapMode="word"
					selectable
					paddingRight={1}
				>
					{body()}
				</text>
			</scrollbox>
		</box>
	);
}

export function GitView(props: {
	theme: Theme;
	visible: readonly GitBranch[];
	selected: number;
	query: string;
	note?: string;
	outcome?: GitActionOutcome;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedBranch = () =>
		props.visible[props.selected] ?? props.visible[0];
	createEffect(() => {
		const branch = selectedBranch();
		if (!scroll || !branch) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`branch-${props.selected}`),
		);
	});
	const outcomeTone = () => {
		if (props.outcome?.status === "completed") return "success" as const;
		if (props.outcome?.status === "refused") return "warning" as const;
		return "error" as const;
	};
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<Show when={props.outcome}>
				{(outcome) => (
					<text
						fg={toneColor(props.theme, outcomeTone())}
						wrapMode="none"
						truncate
					>
						{outcome().action} {outcome().status}
						{outcome().reason ? ` · ${outcome().reason}` : ""}
					</text>
				)}
			</Show>
			<Show
				when={props.visible.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.query.trim()
							? `No branch matches “${props.query.trim()}”.`
							: props.note === "unavailable"
								? "Branches unavailable."
								: "No local branches."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.visible}>
						{(branch, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`branch-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text
										fg={
											selected()
												? props.theme.text.base
												: props.theme.text.muted
										}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{branch.name}
									</text>
									<Show when={branch.upstream}>
										<text
											fg={props.theme.text.muted}
											wrapMode="none"
											truncate
											flexShrink={0}
										>
											{branch.upstream}
										</text>
									</Show>
									<Show when={branch.ahead > 0}>
										<text fg={props.theme.text.feedback.success.base}>
											↑{branch.ahead}
										</text>
									</Show>
									<Show when={branch.behind > 0}>
										<text fg={props.theme.text.feedback.warning.base}>
											↓{branch.behind}
										</text>
									</Show>
									<Show when={branch.current}>
										<Badge theme={props.theme} label="current" tone="success" />
									</Show>
									<Show when={branch.gone}>
										<Badge theme={props.theme} label="gone" tone="warning" />
									</Show>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function WorktreesView(props: {
	theme: Theme;
	app: EnvironmentApp;
	worktrees: GitWorktrees;
	selected: number;
	executionWorktree?: string;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedWorktree = () =>
		props.worktrees.worktrees[props.selected] ?? props.worktrees.worktrees[0];
	createEffect(() => {
		const worktree = selectedWorktree();
		if (!scroll || !worktree) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`worktree-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>Worktrees</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" truncate flexGrow={1}>
					{props.app.id}
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.worktrees.worktrees.length}
				</text>
			</box>
			<Show
				when={props.worktrees.worktrees.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.worktrees.note === "unavailable"
							? "Worktrees unavailable."
							: "No worktrees."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.worktrees.worktrees}>
						{(worktree, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`worktree-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text
										fg={
											selected()
												? props.theme.text.base
												: props.theme.text.muted
										}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{worktree.path}
									</text>
									<text fg={props.theme.text.muted} flexShrink={0}>
										{worktree.branch ?? "detached"}
									</text>
									<Show when={props.executionWorktree === worktree.path}>
										<Badge theme={props.theme} label="execution" tone="info" />
									</Show>
									<Show when={worktree.current}>
										<Badge theme={props.theme} label="current" tone="success" />
									</Show>
									<Show when={worktree.detached}>
										<Badge
											theme={props.theme}
											label="detached"
											tone="warning"
										/>
									</Show>
									<Show when={worktree.locked}>
										<Badge theme={props.theme} label="locked" tone="warning" />
									</Show>
									<Show when={worktree.prunable}>
										<Badge
											theme={props.theme}
											label="prunable"
											tone="warning"
										/>
									</Show>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function RemotesView(props: {
	theme: Theme;
	app: EnvironmentApp;
	remotes: GitRemotes;
	selected: number;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedRemote = () =>
		props.remotes.remotes[props.selected] ?? props.remotes.remotes[0];
	createEffect(() => {
		const remote = selectedRemote();
		if (!scroll || !remote) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`remote-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>Remotes</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" truncate flexGrow={1}>
					{props.app.id}
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.remotes.remotes.length}
				</text>
			</box>
			<Show
				when={props.remotes.remotes.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.remotes.note === "unavailable"
							? "Remotes unavailable."
							: "No remotes configured."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.remotes.remotes}>
						{(remote, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`remote-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text
										fg={props.theme.text.feedback.info.base}
										wrapMode="none"
										flexShrink={0}
									>
										{remote.name}
									</text>
									<text
										fg={props.theme.text.muted}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{remote.fetchUrl}
									</text>
									<Show when={remote.pushUrl}>
										<Badge
											theme={props.theme}
											label="split push"
											tone="warning"
										/>
									</Show>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function RemoteAddView(props: {
	theme: Theme;
	app: EnvironmentApp;
	name: string;
	url: string;
	field: number;
	onNameInput(value: string): void;
	onUrlInput(value: string): void;
	onSubmit(): void;
}) {
	let nameInput: InputRenderable | undefined;
	let urlInput: InputRenderable | undefined;
	createEffect(() => {
		const field = props.field;
		queueMicrotask(() =>
			field === 0 ? nameInput?.focus() : urlInput?.focus(),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>New remote</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" truncate flexGrow={1}>
					{props.app.id}
				</text>
			</box>
			<text fg={props.theme.text.muted} wrapMode="word">
				Credential-bearing HTTP URLs are refused; use a credential helper.
			</text>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={props.theme.text.muted} width={6} flexShrink={0}>
					Name
				</text>
				<input
					ref={(value: InputRenderable) => {
						nameInput = value;
					}}
					value={props.name}
					placeholder="origin"
					backgroundColor={props.theme.background.base}
					focusedBackgroundColor={props.theme.background.raised.base}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onNameInput}
					onSubmit={props.onSubmit}
					flexGrow={1}
				/>
			</box>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={props.theme.text.muted} width={6} flexShrink={0}>
					URL
				</text>
				<input
					ref={(value: InputRenderable) => {
						urlInput = value;
					}}
					value={props.url}
					placeholder="git@host:repo.git or https://host/repo.git"
					backgroundColor={props.theme.background.base}
					focusedBackgroundColor={props.theme.background.raised.base}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onUrlInput}
					onSubmit={props.onSubmit}
					flexGrow={1}
				/>
			</box>
		</box>
	);
}

export function WorktreeAddView(props: {
	theme: Theme;
	app: EnvironmentApp;
	branch: string;
	path: string;
	field: number;
	newBranch: boolean;
	onPathInput(value: string): void;
	onBranchInput(value: string): void;
	onSubmit(): void;
}) {
	let pathInput: InputRenderable | undefined;
	let branchInput: InputRenderable | undefined;
	createEffect(() => {
		const field = props.field;
		queueMicrotask(() =>
			field === 0 ? pathInput?.focus() : branchInput?.focus(),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>New worktree</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" truncate flexGrow={1}>
					{props.app.id}
				</text>
				<Badge
					theme={props.theme}
					label={props.newBranch ? "new branch" : "existing branch"}
					tone={props.newBranch ? "warning" : "info"}
				/>
			</box>
			<text fg={props.theme.text.muted} wrapMode="word">
				The path must be outside the repository. Tab switches fields.
			</text>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={props.theme.text.muted} width={6} flexShrink={0}>
					Path
				</text>
				<input
					ref={(value: InputRenderable) => {
						pathInput = value;
					}}
					value={props.path}
					placeholder="/absolute/path/to/worktree"
					backgroundColor={props.theme.background.base}
					focusedBackgroundColor={props.theme.background.raised.base}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onPathInput}
					onSubmit={props.onSubmit}
					flexGrow={1}
				/>
			</box>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={props.theme.text.muted} width={6} flexShrink={0}>
					Branch
				</text>
				<input
					ref={(value: InputRenderable) => {
						branchInput = value;
					}}
					value={props.branch}
					placeholder="branch name"
					backgroundColor={props.theme.background.base}
					focusedBackgroundColor={props.theme.background.raised.base}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onBranchInput}
					onSubmit={props.onSubmit}
					flexGrow={1}
				/>
			</box>
		</box>
	);
}

export function AppDetail(props: {
	theme: Theme;
	app: EnvironmentApp;
	status: EnvironmentStatus;
	owned: readonly OwnedResource[];
	git: ReadonlyMap<string, GitStatus>;
	active: ReadonlyMap<string, { action?: string }>;
	worktree?: string;
	operations: readonly OperationSummary[];
	subjects: (operation: OperationSummary) => OperationSubject | undefined;
	onExecute(action: string, target: EnvironmentTarget): void;
	onStop(): void;
	onLogs(): void;
	onHistory(): void;
	onTelemetry(): void;
}) {
	const owned = () => ownedFor(props.status, props.app.id);
	const status = () =>
		appStatus(owned().length, props.active.get(props.app.id));
	const currentGit = () => props.git.get(props.app.repository);
	const gitValue = () => {
		const current = currentGit();
		if (!current || current.state === "unknown") return "unavailable";
		const branch =
			current.branch ?? (current.head ? `@${current.head}` : "detached");
		const changes: string[] = [];
		if (current.state === "clean") changes.push("clean");
		else {
			if (current.modified) changes.push(`~${current.modified}`);
			if (current.added) changes.push(`+${current.added}`);
			if (current.deleted) changes.push(`-${current.deleted}`);
		}
		if (current.ahead) changes.push(`↑${current.ahead}`);
		if (current.behind) changes.push(`↓${current.behind}`);
		return [branch, ...(changes.length ? [changes.join(" ")] : [])].join(" · ");
	};
	const gitTone = (): "warning" | "muted" | "normal" => {
		const current = currentGit();
		if (!current || current.state === "unknown") return "muted";
		return current.state === "dirty" ? "warning" : "normal";
	};
	const defaultTargets = () =>
		["build", "test", "run"]
			.flatMap((action) => {
				const id = props.app.defaults[action];
				return id ? [`${actionGlyph(action)} ${id}`] : [];
			})
			.join(" · ") || "none";
	const recent = () =>
		props.operations
			.filter((operation) => props.subjects(operation)?.app === props.app.id)
			.slice(0, 5);

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none" truncate flexGrow={1}>
					<b>{props.app.id}</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.app.kind}
				</text>
			</box>
			<text fg={props.theme.text.muted} wrapMode="word">
				{props.app.repository}
			</text>
			<scrollbox
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<box flexDirection="column" gap={1} paddingRight={1}>
					<Section theme={props.theme} title="Overview">
						<Property theme={props.theme} label="Kind" value={props.app.kind} />
						<Property
							theme={props.theme}
							label="Repository"
							value={props.app.repository}
						/>
						<Property
							theme={props.theme}
							label="Git"
							value={gitValue()}
							tone={gitTone()}
						/>
						<Property
							theme={props.theme}
							label="Status"
							value={status().label}
							tone={status().tone}
						/>
						<Show when={props.worktree}>
							<Property
								theme={props.theme}
								label="Worktree"
								value={props.worktree ?? ""}
								tone="info"
							/>
						</Show>
						<Property
							theme={props.theme}
							label="Defaults"
							value={defaultTargets()}
						/>
						<Property
							theme={props.theme}
							label="Targets"
							value={`${props.app.targets.length} configured`}
						/>
						<Property
							theme={props.theme}
							label="Scope"
							value={scopeLabel(props.status)}
						/>
						<Property
							theme={props.theme}
							label="Owned"
							value={`${owned().length} resource${owned().length === 1 ? "" : "s"}`}
							tone={owned().length ? "warning" : "muted"}
						/>
					</Section>

					<Section
						theme={props.theme}
						title="Targets"
						right="Enter or click to execute"
					>
						<Show
							when={props.app.targets.length > 0}
							fallback={
								<text fg={props.theme.text.muted}>No targets configured.</text>
							}
						>
							<For each={props.app.targets}>
								{(target) => {
									const isDefault =
										props.app.defaults[target.action] === target.id;
									return (
										<box
											flexDirection="row"
											gap={1}
											paddingTop={1}
											paddingBottom={1}
											onMouseUp={() => props.onExecute(target.action, target)}
										>
											<text
												fg={props.theme.text.feedback.info.base}
												width={2}
												flexShrink={0}
											>
												{actionGlyph(target.action)}
											</text>
											<text
												fg={props.theme.text.base}
												wrapMode="none"
												truncate
												flexGrow={1}
											>
												{target.id}
											</text>
											<Show when={isDefault}>
												<Badge
													theme={props.theme}
													label="selected"
													tone="success"
												/>
											</Show>
											<text
												fg={props.theme.text.muted}
												wrapMode="none"
												flexShrink={0}
											>
												{target.runtime}
												{target.profile ? ` · ${target.profile}` : ""}
											</text>
										</box>
									);
								}}
							</For>
						</Show>
					</Section>

					<Section
						theme={props.theme}
						title="Owned resources"
						right={`${owned().length}`}
					>
						<Show
							when={owned().length > 0}
							fallback={
								<text fg={props.theme.text.muted}>
									No owned resources for this app.
								</text>
							}
						>
							<For each={owned()}>
								{(resource) => (
									<box flexDirection="row" gap={1} minWidth={0}>
										<text
											fg={props.theme.text.feedback.warning.base}
											width={12}
											flexShrink={0}
										>
											{resource.kind}
										</text>
										<text
											fg={props.theme.text.base}
											wrapMode="none"
											truncate
											flexGrow={1}
										>
											{shortId(resource.runtimeId)}
										</text>
										<text fg={props.theme.text.muted} flexShrink={0}>
											{formatTimestamp(resource.createdAt)}
										</text>
									</box>
								)}
							</For>
						</Show>
					</Section>

					<Section
						theme={props.theme}
						title="Recent receipts"
						right={`${props.operations.length} total`}
					>
						<Show
							when={recent().length > 0}
							fallback={
								<text fg={props.theme.text.muted}>
									No operation receipts yet.
								</text>
							}
						>
							<For each={recent()}>
								{(operation) => {
									const subject = () => props.subjects(operation);
									return (
										<box flexDirection="row" gap={1} minWidth={0}>
											<text
												fg={
													operation.state === "completed"
														? props.theme.text.feedback.success.base
														: operation.state === "rejected" ||
																operation.state === "interrupted"
															? props.theme.text.feedback.error.base
															: props.theme.text.feedback.warning.base
												}
												width={18}
												flexShrink={0}
											>
												{operation.state}
											</text>
											<text
												fg={props.theme.text.muted}
												wrapMode="none"
												truncate
												flexGrow={1}
											>
												{subject()
													? `${subject()?.app} · ${subject()?.target}${subject()?.action ? ` · ${subject()?.action}` : ""}`
													: shortId(operation.id)}
											</text>
											<text fg={props.theme.text.muted} flexShrink={0}>
												{formatTimestamp(operation.createdAt)}
											</text>
										</box>
									);
								}}
							</For>
						</Show>
					</Section>

					<Section theme={props.theme} title="Actions">
						<text fg={props.theme.text.muted} wrapMode="word">
							b build · s start/run · t test · S stop · l logs · L history · e
							telemetry
						</text>
					</Section>
				</box>
			</scrollbox>
		</box>
	);
}

export function TargetPicker(props: {
	theme: Theme;
	app: EnvironmentApp;
	action: string;
	targets: readonly EnvironmentTarget[];
	selected: number;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center">
				<text fg={props.theme.text.base}>
					<b>{actionGlyph(props.action)}</b>
				</text>
				<text fg={props.theme.text.muted}>{props.app.id}</text>
			</box>
			<text fg={props.theme.text.muted}>
				Choose the exact configured target. The next step executes directly.
			</text>
			<Show
				when={props.targets.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						No {actionGlyph(props.action)} target configured.
					</text>
				}
			>
				<scrollbox
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.targets}>
						{(target, index) => {
							const selected = () => index() === props.selected;
							const isDefault = props.app.defaults[props.action] === target.id;
							return (
								<box
									flexDirection="column"
									paddingLeft={2}
									paddingRight={2}
									paddingTop={1}
									paddingBottom={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<box flexDirection="row" gap={1} minWidth={0}>
										<text
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
											flexShrink={0}
										>
											{selected() ? "›" : " "}
										</text>
										<text
											fg={
												selected()
													? props.theme.text.base
													: props.theme.text.muted
											}
											wrapMode="none"
											truncate
											flexGrow={1}
										>
											<b>{target.id}</b>
										</text>
										<Show when={isDefault}>
											<Badge
												theme={props.theme}
												label="selected"
												tone="success"
											/>
										</Show>
									</box>
									<text
										fg={props.theme.text.muted}
										paddingLeft={2}
										wrapMode="word"
									>
										{targetLabel(target)}
									</text>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function HistoryView(props: {
	theme: Theme;
	operations: readonly OperationSummary[];
	total: number;
	selected: number;
	subjects: (operation: OperationSummary) => OperationSubject | undefined;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center">
				<text fg={props.theme.text.base}>
					<b>Operation history</b>
				</text>
				<text fg={props.theme.text.muted}>{props.total} receipts</text>
			</box>
			<Show
				when={props.operations.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						No operation receipts in this scope.
					</text>
				}
			>
				<scrollbox
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.operations}>
						{(operation, index) => {
							const selected = () => index() === props.selected;
							const subject = () => props.subjects(operation);
							return (
								<box
									flexDirection="column"
									paddingLeft={2}
									paddingRight={2}
									paddingTop={1}
									paddingBottom={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<box flexDirection="row" gap={1} minWidth={0}>
										<text
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
											flexShrink={0}
										>
											{selected() ? "›" : " "}
										</text>
										<text
											fg={
												operation.state === "completed"
													? props.theme.text.feedback.success.base
													: operation.state === "rejected" ||
															operation.state === "interrupted"
														? props.theme.text.feedback.error.base
														: props.theme.text.feedback.warning.base
											}
											width={18}
											flexShrink={0}
										>
											{operation.state}
										</text>
										<text
											fg={
												selected()
													? props.theme.text.base
													: props.theme.text.muted
											}
											wrapMode="none"
											truncate
											flexGrow={1}
										>
											{subject()
												? `${subject()?.app} · ${subject()?.target}${subject()?.action ? ` · ${subject()?.action}` : ""}`
												: shortId(operation.id)}
										</text>
										<text fg={props.theme.text.muted} flexShrink={0}>
											{formatTimestamp(operation.createdAt)}
										</text>
									</box>
									<text
										fg={props.theme.text.muted}
										paddingLeft={2}
										wrapMode="none"
										truncate
									>
										{operation.kind} · rev {operation.revision} ·{" "}
										{shortId(operation.id)}
										{operation.hasResult ? " · has result" : ""}
									</text>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

function BuildStepsView(props: {
	theme: Theme;
	output: BuildOutput;
	selectedIndex: number;
	onSelect(index: number): void;
}) {
	const step = () =>
		props.output.steps[props.selectedIndex] ?? props.output.steps[0];
	let stepsScroll: ScrollBoxRenderable | undefined;
	createEffect(() => {
		const current = step();
		if (!current) return;
		queueMicrotask(() =>
			stepsScroll?.scrollChildIntoView(`build-step-${current.id}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<scrollbox
				ref={(value: ScrollBoxRenderable) => {
					stepsScroll = value;
				}}
				height={Math.min(12, Math.max(4, props.output.steps.length + 1))}
				flexShrink={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<For each={props.output.steps}>
					{(item, index) => {
						const selected = () => index() === props.selectedIndex;
						return (
							<box
								id={`build-step-${item.id}`}
								flexDirection="row"
								gap={1}
								paddingLeft={1}
								paddingRight={1}
								height={1}
								backgroundColor={
									selected() ? props.theme.background.raised.high : undefined
								}
								onMouseUp={() => props.onSelect(index())}
							>
								<text
									fg={toneColor(props.theme, buildStepTone(item.status))}
									flexShrink={0}
								>
									{buildStepIcon(item.status)}
								</text>
								<text
									fg={
										selected() ? props.theme.text.base : props.theme.text.muted
									}
									wrapMode="none"
									truncate
									flexGrow={1}
									minWidth={0}
								>
									{item.title}
								</text>
								<Show when={item.status === "cached"}>
									<Badge theme={props.theme} label="cached" tone="muted" />
								</Show>
								<text
									fg={props.theme.text.muted}
									wrapMode="none"
									flexShrink={0}
								>
									{item.duration ?? ""}
								</text>
							</box>
						);
					}}
				</For>
			</scrollbox>
			<box flexDirection="column" flexGrow={1} minHeight={0}>
				<box flexDirection="row" flexShrink={0}>
					<text
						fg={props.theme.text.feedback.info.base}
						wrapMode="none"
						truncate
					>
						<b>Step log</b>
						{step() ? ` · ${step()?.title}` : ""}
					</text>
				</box>
				<scrollbox
					flexGrow={1}
					minHeight={0}
					stickyScroll
					stickyStart="bottom"
					horizontalScrollbarOptions={{ visible: false }}
				>
					<text
						fg={props.theme.text.base}
						wrapMode="word"
						selectable
						paddingRight={1}
					>
						{step()?.logs.length
							? step()
									?.logs.map((line, index) => `${index + 1}  ${line}`)
									.join("\n")
							: "No output for this step."}
					</text>
				</scrollbox>
			</box>
		</box>
	);
}

export function OperationView(props: {
	theme: Theme;
	context: Context;
	active: () => boolean;
	operation: OperationDetail;
	progress?: string;
	receipt: ExecutionReceipt | null;
	subject: OperationSubject | undefined;
	onRefresh(): void;
}) {
	const [tab, setTab] = createSignal<"info" | "steps" | "logs">("info");
	const [stepIndex, setStepIndex] = createSignal(0);
	let initialized = false;
	let userSelected = false;
	let effectOperationId = props.operation.id;
	const rawReceipt = createMemo<ExecutionReceipt | null>(() => {
		if (props.receipt) return props.receipt;
		if (!props.operation.result) return null;
		try {
			const parsed = JSON.parse(props.operation.result) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as ExecutionReceipt)
				: null;
		} catch {
			return null;
		}
	});
	const liveText = createMemo(() => {
		const text = props.progress ?? "";
		const end = text.lastIndexOf("\n");
		return end >= 0 ? text.slice(0, end + 1) : "";
	});
	const receiptBuild = createMemo(() => {
		const current = rawReceipt();
		return current?.kind === "docker-build"
			? parseBuildOutput(receiptText(current))
			: undefined;
	});
	const liveBuild = createMemo(() =>
		liveText() ? parseBuildOutput(liveText()) : undefined,
	);
	const build = createMemo(() => mergeBuildOutput(liveBuild(), receiptBuild()));
	const hasSteps = () => Boolean(build()?.steps.length);
	const hasLogs = () => Boolean(rawReceipt()) || Boolean(liveText());
	const tabs = (): readonly ("info" | "steps" | "logs")[] => {
		const list: ("info" | "steps" | "logs")[] = ["info"];
		if (hasSteps()) list.push("steps");
		if (hasLogs()) list.push("logs");
		return list;
	};
	const cycleTab = (delta: number) => {
		const list = tabs();
		const index = list.indexOf(tab());
		const next = list[(index + delta + list.length) % list.length];
		if (next) setTab(next);
	};
	const selectStep = (index: number) => {
		userSelected = true;
		setStepIndex(index);
	};
	const moveStep = (delta: number) => {
		const count = build()?.steps.length ?? 0;
		if (!count) return;
		setStepIndex((current) => {
			userSelected = true;
			return (current + delta + count) % count;
		});
	};
	createEffect(() => {
		if (!tabs().includes(tab())) setTab("info");
	});
	createEffect(() => {
		if (props.operation.id !== effectOperationId) {
			effectOperationId = props.operation.id;
			initialized = false;
			userSelected = false;
			setStepIndex(0);
			setTab("info");
		}
		const steps = build()?.steps;
		if (!steps?.length) return;
		if (!initialized) {
			initialized = true;
			setTab("steps");
		}
		if (untrack(stepIndex) >= steps.length) setStepIndex(0);
		const error = steps.findIndex((step) => step.status === "error");
		if (error >= 0) {
			setStepIndex(error);
			return;
		}
		if (userSelected) return;
		for (let index = steps.length - 1; index >= 0; index -= 1) {
			if (steps[index]?.status === "running") {
				setStepIndex(index);
				return;
			}
		}
	});
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: props.active,
		commands: [
			{
				bind: "tab",
				title: "Next operation tab",
				group: "Environments",
				run: () => cycleTab(1),
			},
			{
				bind: "shift+tab",
				title: "Previous operation tab",
				group: "Environments",
				run: () => cycleTab(-1),
			},
			{
				bind: "1",
				title: "Info tab",
				group: "Environments",
				run: () => setTab("info"),
			},
			{
				bind: "2",
				title: "Build steps tab",
				group: "Environments",
				enabled: hasSteps,
				run: () => setTab("steps"),
			},
			{
				bind: "3",
				title: "Build logs tab",
				group: "Environments",
				enabled: hasLogs,
				run: () => setTab("logs"),
			},
			{
				bind: "up,k",
				title: "Previous build step",
				group: "Environments",
				enabled: () => tab() === "steps",
				run: () => moveStep(-1),
			},
			{
				bind: "down,j",
				title: "Next build step",
				group: "Environments",
				enabled: () => tab() === "steps",
				run: () => moveStep(1),
			},
		],
	}));
	const result = createMemo(() => {
		const live = liveText();
		const current = rawReceipt();
		if (current) {
			const settled = receiptText(current);
			return live.length > settled.length ? live : settled;
		}
		if (live) return live;
		if (!props.operation.result) return undefined;
		try {
			return prettyJson(JSON.parse(props.operation.result));
		} catch {
			return props.operation.result;
		}
	});
	const tabLabel = (value: string) =>
		value === "info" ? "Info" : value === "steps" ? "Steps" : "Logs";
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="column" gap={1} flexShrink={0}>
				<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
					<text fg={props.theme.text.base} wrapMode="none">
						<b>Operation</b>
					</text>
					<Badge
						theme={props.theme}
						label={props.operation.state}
						tone={
							props.operation.state === "completed"
								? "success"
								: props.operation.state === "interrupted"
									? "error"
									: "warning"
						}
					/>
					<box flexGrow={1} />
					<text fg={props.theme.text.muted} wrapMode="none">
						{shortId(props.operation.id)}
					</text>
				</box>
				<box flexDirection="row" gap={1} flexWrap="wrap">
					<For each={tabs()}>
						{(item) => (
							<box
								paddingLeft={1}
								paddingRight={1}
								backgroundColor={
									tab() === item
										? props.theme.background.action.primary.focused
										: undefined
								}
								onMouseUp={() => setTab(item)}
							>
								<text
									fg={
										tab() === item
											? props.theme.text.action.primary.focused
											: props.theme.text.muted
									}
									wrapMode="none"
								>
									{tabLabel(item)}
								</text>
							</box>
						)}
					</For>
				</box>
			</box>
			<Switch>
				<Match when={tab() === "info"}>
					<scrollbox
						flexGrow={1}
						minHeight={0}
						horizontalScrollbarOptions={{ visible: false }}
					>
						<box flexDirection="column" gap={1} paddingRight={1}>
							<Section theme={props.theme} title="Subject">
								<Show when={!props.subject}>
									<text fg={props.theme.text.muted}>
										Older receipt; app/target attribution is unavailable.
									</text>
								</Show>
								<Property
									theme={props.theme}
									label="Application"
									value={props.subject?.app ?? "—"}
								/>
								<Property
									theme={props.theme}
									label="Target"
									value={props.subject?.target ?? "—"}
								/>
								<Property
									theme={props.theme}
									label="Action"
									value={props.subject?.action ?? "—"}
								/>
								<Property
									theme={props.theme}
									label="Repository"
									value={props.subject?.repository ?? "—"}
								/>
							</Section>
							<Section theme={props.theme} title="Receipt">
								<Property
									theme={props.theme}
									label="Id"
									value={props.operation.id}
								/>
								<Property
									theme={props.theme}
									label="Kind"
									value={props.operation.kind}
								/>
								<Property
									theme={props.theme}
									label="Revision"
									value={String(props.operation.revision)}
								/>
								<Property
									theme={props.theme}
									label="Digest"
									value={shortId(props.operation.digest)}
								/>
								<Property
									theme={props.theme}
									label="Created"
									value={formatTimestamp(props.operation.createdAt)}
								/>
								<Show when={props.operation.inspectionRequired}>
									<Property
										theme={props.theme}
										label="Inspection"
										value="required — do not retry automatically"
										tone="error"
									/>
								</Show>
							</Section>
							<Show when={props.operation.state === "interrupted"}>
								<text fg={props.theme.text.feedback.error.base}>
									Interrupted — inspect the receipt before retrying.
								</text>
							</Show>
							<Show when={result()}>
								{(value) => (
									<Section theme={props.theme} title="Result" grow>
										<scrollbox
											flexGrow={1}
											minHeight={0}
											horizontalScrollbarOptions={{ visible: false }}
										>
											<text
												fg={props.theme.text.base}
												wrapMode="word"
												selectable
											>
												{value()}
											</text>
										</scrollbox>
									</Section>
								)}
							</Show>
						</box>
					</scrollbox>
				</Match>
				<Match when={tab() === "steps"}>
					<Show
						when={build()}
						fallback={
							<text fg={props.theme.text.muted}>
								No build steps parsed for this receipt.
							</text>
						}
					>
						{(output) => (
							<BuildStepsView
								theme={props.theme}
								output={output()}
								selectedIndex={stepIndex()}
								onSelect={selectStep}
							/>
						)}
					</Show>
				</Match>
				<Match when={tab() === "logs"}>
					<scrollbox
						flexGrow={1}
						minHeight={0}
						stickyScroll
						stickyStart="bottom"
						horizontalScrollbarOptions={{ visible: false }}
					>
						<text
							fg={props.theme.text.base}
							wrapMode="word"
							selectable
							paddingRight={1}
						>
							{result() ?? "No settled output yet."}
						</text>
					</scrollbox>
				</Match>
			</Switch>
		</box>
	);
}

export function LogsView(props: {
	theme: Theme;
	app: EnvironmentApp;
	logs: LogsSnapshot;
	onReload(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	onMount(() => queueMicrotask(() => scroll?.focus()));
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center">
				<text fg={props.theme.text.base}>
					<b>Logs</b>
				</text>
				<text fg={props.theme.text.muted}>{props.app.id}</text>
				<Show when={props.logs.historical}>
					<Badge theme={props.theme} label="retained" tone="warning" />
				</Show>
				<text fg={props.theme.text.muted}>
					tail {props.logs.tail}
					{props.logs.retainedAt
						? ` · retained ${formatTimestamp(props.logs.retainedAt)}`
						: ""}
				</text>
			</box>
			<scrollbox
				ref={(value: ScrollBoxRenderable) => {
					scroll = value;
				}}
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<text fg={props.theme.text.base} wrapMode="word" selectable>
					{props.logs.output.trim() || "No logs available."}
				</text>
			</scrollbox>
		</box>
	);
}

export function TelemetryView(props: {
	theme: Theme;
	app: EnvironmentApp;
	telemetry: TelemetrySnapshot;
	traceId: string | undefined;
	selectedTraceIndex: number;
	onSelectTrace(index: number): void;
	onOpenTrace(trace: TelemetryTrace): void;
}) {
	const formatted = createMemo(() => {
		try {
			return formatTelemetryResult(props.telemetry.raw);
		} catch {
			return prettyJson(props.telemetry.raw);
		}
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center">
				<text fg={props.theme.text.base}>
					<b>Telemetry</b>
				</text>
				<text fg={props.theme.text.muted}>{props.app.id}</text>
				<Show when={props.telemetry.transport}>
					<text fg={props.theme.text.muted}>{props.telemetry.transport}</text>
				</Show>
				<Show when={props.telemetry.bytes !== undefined}>
					<text fg={props.theme.text.muted}>{props.telemetry.bytes} bytes</text>
				</Show>
			</box>
			<scrollbox
				height={props.traceId ? undefined : 14}
				flexGrow={props.traceId ? 1 : 0}
				flexShrink={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<text fg={props.theme.text.base} wrapMode="word" selectable>
					{formatted()}
				</text>
			</scrollbox>
			<Show when={!props.traceId && props.telemetry.traces.length > 0}>
				<box flexDirection="column" flexGrow={1} minHeight={0}>
					<text fg={props.theme.text.feedback.info.base} paddingBottom={1}>
						<b>Traces</b>
					</text>
					<scrollbox
						flexGrow={1}
						minHeight={0}
						horizontalScrollbarOptions={{ visible: false }}
					>
						<For each={props.telemetry.traces}>
							{(trace, index) => {
								const selected = () => index() === props.selectedTraceIndex;
								return (
									<box
										flexDirection="column"
										paddingLeft={2}
										paddingRight={2}
										paddingTop={1}
										paddingBottom={1}
										backgroundColor={
											selected()
												? props.theme.background.raised.high
												: undefined
										}
										onMouseUp={() => {
											props.onSelectTrace(index());
											props.onOpenTrace(trace);
										}}
									>
										<box flexDirection="row" gap={1} minWidth={0}>
											<text
												fg={
													selected()
														? props.theme.text.action.primary.base
														: props.theme.text.muted
												}
												flexShrink={0}
											>
												{selected() ? "›" : " "}
											</text>
											<text
												fg={
													selected()
														? props.theme.text.base
														: props.theme.text.muted
												}
												wrapMode="none"
												truncate
												flexGrow={1}
											>
												<b>{trace.root || "(unnamed)"}</b>
											</text>
											<Show when={trace.errors > 0}>
												<Badge
													theme={props.theme}
													label={`${trace.errors} error${trace.errors === 1 ? "" : "s"}`}
													tone="error"
												/>
											</Show>
										</box>
										<text
											fg={props.theme.text.muted}
											paddingLeft={2}
											wrapMode="none"
											truncate
										>
											{shortId(trace.traceId)} · {trace.spanCount} span
											{trace.spanCount === 1 ? "" : "s"}
										</text>
									</box>
								);
							}}
						</For>
					</scrollbox>
				</box>
			</Show>
		</box>
	);
}

export function ServicesView(props: {
	theme: Theme;
	services: readonly EnvironmentService[];
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center">
				<text fg={props.theme.text.base}>
					<b>Services</b>
				</text>
				<text fg={props.theme.text.muted}>
					{props.services.length} configured
				</text>
			</box>
			<Show
				when={props.services.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						No configured service bindings.
					</text>
				}
			>
				<scrollbox
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.services}>
						{(service) => (
							<box
								flexDirection="column"
								paddingLeft={2}
								paddingRight={2}
								paddingTop={1}
								paddingBottom={1}
							>
								<box flexDirection="row" gap={1} minWidth={0}>
									<text fg={props.theme.text.base} flexGrow={1}>
										<b>{service.id}</b>
									</text>
									<Show when={service.shared?.state}>
										<Badge
											theme={props.theme}
											label={service.shared?.state ?? ""}
											tone={
												service.shared?.state === "ready"
													? "success"
													: service.shared?.state === "uncertain"
														? "error"
														: "warning"
											}
										/>
									</Show>
								</box>
								<text fg={props.theme.text.muted} wrapMode="word">
									{service.runtime ?? "unknown runtime"}
									{service.readiness ? ` · ${service.readiness}` : ""}
									{service.start
										? ` · start ${service.start.app}/${service.start.target}`
										: ""}
								</text>
								<Show when={service.shared?.leases?.length}>
									<text fg={props.theme.text.muted} wrapMode="word">
										{service.shared?.leases?.length} lease
										{service.shared?.leases?.length === 1 ? "" : "s"}
									</text>
								</Show>
							</box>
						)}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

function providerTone(
	state: string,
): "success" | "error" | "warning" | "muted" | "info" {
	if (["open", "opened", "success", "completed", "passed"].includes(state))
		return "success";
	if (["failed", "failure", "error", "cancelled"].includes(state))
		return "error";
	if (
		["running", "pending", "queued", "in_progress", "created"].includes(state)
	)
		return "warning";
	if (["merged", "closed"].includes(state)) return "info";
	return "muted";
}

function ProviderHeader(props: {
	theme: Theme;
	title: string;
	context: string;
	count: number;
}) {
	return (
		<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
			<text fg={props.theme.text.base} wrapMode="none" flexShrink={0}>
				<b>{props.title}</b>
			</text>
			<text
				fg={props.theme.text.muted}
				wrapMode="none"
				truncate
				flexGrow={1}
				minWidth={0}
			>
				{props.context}
			</text>
			<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
				{props.count}
			</text>
		</box>
	);
}

function ProviderFilterRow(props: {
	theme: Theme;
	value: string;
	focused: boolean;
	placeholder: string;
	onInput(value: string): void;
	onSubmit(): void;
	onRef(input: InputRenderable | undefined): void;
	onFocus(): void;
	onBlur(): void;
}) {
	return (
		<box flexDirection="row" gap={1} height={1} flexShrink={0}>
			<text fg={props.theme.text.muted} flexShrink={0}>
				/
			</text>
			<Show
				when={props.focused}
				fallback={
					<text
						fg={props.theme.text.muted}
						wrapMode="none"
						truncate
						flexGrow={1}
					>
						{props.value || props.placeholder}
					</text>
				}
			>
				<input
					ref={(value: InputRenderable) => props.onRef(value)}
					value={props.value}
					placeholder={props.placeholder}
					focused
					backgroundColor={props.theme.background.base}
					focusedBackgroundColor={props.theme.background.raised.base}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onInput}
					onSubmit={props.onSubmit}
					on:focus={props.onFocus}
					on:blur={props.onBlur}
					flexGrow={1}
				/>
			</Show>
		</box>
	);
}

export function ProvidersView(props: {
	theme: Theme;
	providers: readonly ProviderSummary[];
	selected: number;
	query: string;
	focused: boolean;
	onQuery(value: string): void;
	onSubmit(): void;
	onRef(input: InputRenderable | undefined): void;
	onFocus(): void;
	onBlur(): void;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedProvider = () =>
		props.providers[props.selected] ?? props.providers[0];
	createEffect(() => {
		const provider = selectedProvider();
		if (!scroll || !provider) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Providers"
				context="configured GitHub / GitLab"
				count={props.providers.length}
			/>
			<ProviderFilterRow
				theme={props.theme}
				value={props.query}
				focused={props.focused}
				placeholder="filter providers"
				onInput={props.onQuery}
				onSubmit={props.onSubmit}
				onRef={props.onRef}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
			/>
			<Show
				when={props.providers.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.query.trim()
							? `No provider matches “${props.query.trim()}”.`
							: "No providers configured."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.providers}>
						{(provider, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`provider-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text
										fg={props.theme.text.feedback.info.base}
										wrapMode="none"
										flexShrink={0}
									>
										{provider.name}
									</text>
									<text
										fg={props.theme.text.muted}
										wrapMode="none"
										flexShrink={0}
									>
										{provider.type}
									</text>
									<text
										fg={props.theme.text.base}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{provider.baseUrl}
									</text>
									<Show when={provider.username}>
										<text
											fg={props.theme.text.muted}
											wrapMode="none"
											flexShrink={0}
										>
											{provider.username}
										</text>
									</Show>
									<Badge
										theme={props.theme}
										label={provider.hasToken ? "token" : "no token"}
										tone={provider.hasToken ? "success" : "warning"}
									/>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderReposView(props: {
	theme: Theme;
	provider: ProviderSummary;
	repositories: readonly ProviderRepository[];
	selected: number;
	query: string;
	focused: boolean;
	onQuery(value: string): void;
	onSubmit(): void;
	onRef(input: InputRenderable | undefined): void;
	onFocus(): void;
	onBlur(): void;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedRepository = () =>
		props.repositories[props.selected] ?? props.repositories[0];
	createEffect(() => {
		const repository = selectedRepository();
		if (!scroll || !repository) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-repo-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Repositories"
				context={`${props.provider.name} · ${props.provider.type}`}
				count={props.repositories.length}
			/>
			<ProviderFilterRow
				theme={props.theme}
				value={props.query}
				focused={props.focused}
				placeholder="search repositories; Enter searches"
				onInput={props.onQuery}
				onSubmit={props.onSubmit}
				onRef={props.onRef}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
			/>
			<Show
				when={props.repositories.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.query.trim()
							? "No repository results yet. Press / then Enter to search."
							: "Press / to search repositories."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.repositories}>
						{(repository, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`provider-repo-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text
										fg={props.theme.text.feedback.info.base}
										wrapMode="none"
										flexShrink={0}
									>
										{repository.reference}
									</text>
									<text
										fg={props.theme.text.muted}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{repository.description}
									</text>
									<Show when={repository.defaultBranch}>
										<Badge
											theme={props.theme}
											label={repository.defaultBranch ?? ""}
											tone="muted"
										/>
									</Show>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderChangesView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	state: string;
	changes: readonly ProviderChange[];
	selected: number;
	query: string;
	focused: boolean;
	onQuery(value: string): void;
	onSubmit(): void;
	onRef(input: InputRenderable | undefined): void;
	onFocus(): void;
	onBlur(): void;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedChange = () =>
		props.changes[props.selected] ?? props.changes[0];
	createEffect(() => {
		const change = selectedChange();
		if (!scroll || !change) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-change-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Changes"
				context={`${props.repository} · ${props.provider} · ${props.state}`}
				count={props.changes.length}
			/>
			<ProviderFilterRow
				theme={props.theme}
				value={props.query}
				focused={props.focused}
				placeholder="filter changes"
				onInput={props.onQuery}
				onSubmit={props.onSubmit}
				onRef={props.onRef}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
			/>
			<Show
				when={props.changes.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.query.trim()
							? `No change matches “${props.query.trim()}”.`
							: "No changes for this state."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.changes}>
						{(change, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`provider-change-${index()}`}
									flexDirection="column"
									height={2}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<box flexDirection="row" gap={1} height={1}>
										<text
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
											flexShrink={0}
										>
											{selected() ? "›" : " "}
										</text>
										<text
											fg={props.theme.text.feedback.info.base}
											flexShrink={0}
										>
											#{change.number}
										</text>
										<text
											fg={props.theme.text.base}
											wrapMode="none"
											truncate
											flexGrow={1}
											minWidth={0}
										>
											{change.title}
										</text>
										<Badge
											theme={props.theme}
											label={change.state}
											tone={providerTone(change.state)}
										/>
									</box>
									<box flexDirection="row" gap={1} height={1} paddingLeft={3}>
										<text
											fg={props.theme.text.muted}
											wrapMode="none"
											truncate
											flexGrow={1}
											minWidth={0}
										>
											{change.sourceBranch || "—"} →{" "}
											{change.targetBranch || "—"}
										</text>
										<Show when={change.author}>
											<text
												fg={props.theme.text.muted}
												wrapMode="none"
												flexShrink={0}
											>
												{change.author}
											</text>
										</Show>
									</box>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderIssuesView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	state: string;
	issues: readonly ProviderIssue[];
	selected: number;
	query: string;
	focused: boolean;
	onQuery(value: string): void;
	onSubmit(): void;
	onRef(input: InputRenderable | undefined): void;
	onFocus(): void;
	onBlur(): void;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedIssue = () => props.issues[props.selected] ?? props.issues[0];
	createEffect(() => {
		const issue = selectedIssue();
		if (!scroll || !issue) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-issue-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Issues"
				context={`${props.repository} · ${props.provider} · ${props.state}`}
				count={props.issues.length}
			/>
			<ProviderFilterRow
				theme={props.theme}
				value={props.query}
				focused={props.focused}
				placeholder="filter issues"
				onInput={props.onQuery}
				onSubmit={props.onSubmit}
				onRef={props.onRef}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
			/>
			<Show
				when={props.issues.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.query.trim()
							? `No issue matches “${props.query.trim()}”.`
							: "No issues for this state."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.issues}>
						{(issue, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`provider-issue-${index()}`}
									flexDirection="column"
									height={2}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<box flexDirection="row" gap={1} height={1}>
										<text
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
											flexShrink={0}
										>
											{selected() ? "›" : " "}
										</text>
										<text
											fg={props.theme.text.feedback.info.base}
											flexShrink={0}
										>
											#{issue.number}
										</text>
										<text
											fg={props.theme.text.base}
											wrapMode="none"
											truncate
											flexGrow={1}
											minWidth={0}
										>
											{issue.title}
										</text>
										<Badge
											theme={props.theme}
											label={issue.state}
											tone={providerTone(issue.state)}
										/>
									</box>
									<box flexDirection="row" gap={1} height={1} paddingLeft={3}>
										<Show when={issue.author}>
											<text
												fg={props.theme.text.muted}
												wrapMode="none"
												flexShrink={0}
											>
												{issue.author}
											</text>
										</Show>
										<text
											fg={props.theme.text.muted}
											wrapMode="none"
											truncate
											flexGrow={1}
											minWidth={0}
										>
											{issue.labels.length
												? issue.labels.join(" · ")
												: "no labels"}
										</text>
									</box>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderPipelinesView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	pipelines: readonly ProviderPipeline[];
	selected: number;
	query: string;
	focused: boolean;
	onQuery(value: string): void;
	onSubmit(): void;
	onRef(input: InputRenderable | undefined): void;
	onFocus(): void;
	onBlur(): void;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedPipeline = () =>
		props.pipelines[props.selected] ?? props.pipelines[0];
	createEffect(() => {
		const pipeline = selectedPipeline();
		if (!scroll || !pipeline) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-pipeline-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Pipelines"
				context={`${props.repository} · ${props.provider}`}
				count={props.pipelines.length}
			/>
			<ProviderFilterRow
				theme={props.theme}
				value={props.query}
				focused={props.focused}
				placeholder="filter pipelines"
				onInput={props.onQuery}
				onSubmit={props.onSubmit}
				onRef={props.onRef}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
			/>
			<Show
				when={props.pipelines.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.query.trim()
							? `No pipeline matches “${props.query.trim()}”.`
							: "No pipelines."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.pipelines}>
						{(pipeline, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`provider-pipeline-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text fg={props.theme.text.feedback.info.base} flexShrink={0}>
										#{pipeline.id}
									</text>
									<text
										fg={props.theme.text.base}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{pipeline.name}
									</text>
									<Show when={pipeline.ref}>
										<text
											fg={props.theme.text.muted}
											wrapMode="none"
											flexShrink={0}
										>
											{pipeline.ref}
										</text>
									</Show>
									<Badge
										theme={props.theme}
										label={pipeline.conclusion ?? pipeline.status}
										tone={providerTone(pipeline.conclusion ?? pipeline.status)}
									/>
									<Show when={pipeline.updatedAt}>
										<text
											fg={props.theme.text.muted}
											wrapMode="none"
											flexShrink={0}
										>
											{formatTimestamp(Date.parse(pipeline.updatedAt ?? ""))}
										</text>
									</Show>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderJobsView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	pipeline: ProviderPipeline;
	jobs: readonly ProviderJob[];
	selected: number;
	query: string;
	focused: boolean;
	onQuery(value: string): void;
	onSubmit(): void;
	onRef(input: InputRenderable | undefined): void;
	onFocus(): void;
	onBlur(): void;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedJob = () => props.jobs[props.selected] ?? props.jobs[0];
	createEffect(() => {
		const job = selectedJob();
		if (!scroll || !job) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-job-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Jobs"
				context={`${props.repository} · ${props.provider} · #${props.pipeline.id} ${props.pipeline.name}`}
				count={props.jobs.length}
			/>
			<ProviderFilterRow
				theme={props.theme}
				value={props.query}
				focused={props.focused}
				placeholder="filter jobs"
				onInput={props.onQuery}
				onSubmit={props.onSubmit}
				onRef={props.onRef}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
			/>
			<Show
				when={props.jobs.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						{props.query.trim()
							? `No job matches “${props.query.trim()}”.`
							: "No jobs for this pipeline."}
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.jobs}>
						{(job, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`provider-job-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text fg={props.theme.text.feedback.info.base} flexShrink={0}>
										#{job.id}
									</text>
									<text
										fg={props.theme.text.base}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{job.name}
									</text>
									<Show when={job.stage}>
										<Badge
											theme={props.theme}
											label={job.stage ?? ""}
											tone="muted"
										/>
									</Show>
									<Badge
										theme={props.theme}
										label={job.conclusion ?? job.status}
										tone={providerTone(job.conclusion ?? job.status)}
									/>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderChangeView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	change: ProviderChangeDetail;
}) {
	const syntax = useSyntaxStyle(props.theme);
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={`Change #${props.change.number}`}
				context={`${props.repository} · ${props.provider}`}
				count={props.change.changedFiles ?? 0}
			/>
			<box flexDirection="row" gap={1} height={1} minWidth={0}>
				<text
					fg={props.theme.text.base}
					wrapMode="none"
					truncate
					flexGrow={1}
					minWidth={0}
				>
					{props.change.title}
				</text>
				<Badge
					theme={props.theme}
					label={props.change.state}
					tone={providerTone(props.change.state)}
				/>
			</box>
			<box flexDirection="row" gap={2} height={1} minWidth={0}>
				<text fg={props.theme.text.muted} wrapMode="none" truncate>
					{props.change.sourceBranch || "—"} →{" "}
					{props.change.targetBranch || "—"}
				</text>
				<Show when={props.change.author}>
					<text fg={props.theme.text.muted} wrapMode="none">
						{props.change.author}
					</text>
				</Show>
				<Show when={props.change.additions !== undefined}>
					<text fg={props.theme.text.feedback.success.base} wrapMode="none">
						+{props.change.additions ?? 0}
					</text>
				</Show>
				<Show when={props.change.deletions !== undefined}>
					<text fg={props.theme.text.feedback.error.base} wrapMode="none">
						-{props.change.deletions ?? 0}
					</text>
				</Show>
				<Show when={props.change.createdAt}>
					<text fg={props.theme.text.muted} wrapMode="none">
						{formatTimestamp(Date.parse(props.change.createdAt ?? ""))}
					</text>
				</Show>
			</box>
			<scrollbox
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<markdown
					content={providerMarkdown(props.change.body) || "_No description._"}
					syntaxStyle={syntax}
					fg={props.theme.text.base}
					streaming
				/>
			</scrollbox>
			<text fg={props.theme.text.muted} wrapMode="none">
				d diff · h discussions · c comment · a approve
			</text>
		</box>
	);
}

export function ProviderFilesView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	number: number;
	files: ProviderFiles;
	selected: number;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedFile = () =>
		props.files.files[props.selected] ?? props.files.files[0];
	createEffect(() => {
		const file = selectedFile();
		if (!scroll || !file) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-file-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={`Files #${props.number}`}
				context={`${props.repository} · ${props.provider}`}
				count={props.files.files.length}
			/>
			<Show when={props.files.truncated || props.files.note}>
				<text fg={props.theme.text.feedback.warning.base} wrapMode="none">
					Diff text is incomplete ({props.files.note ?? "size limit"}).
				</text>
			</Show>
			<Show
				when={props.files.files.length > 0}
				fallback={<text fg={props.theme.text.muted}>No changed files.</text>}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.files.files}>
						{(file, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`provider-file-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text
										fg={props.theme.text.base}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{file.path}
									</text>
									<Badge
										theme={props.theme}
										label={file.status}
										tone={providerTone(file.status)}
									/>
									<Show when={file.additions !== undefined}>
										<text
											fg={props.theme.text.feedback.success.base}
											wrapMode="none"
										>
											+{file.additions ?? 0}
										</text>
									</Show>
									<Show when={file.deletions !== undefined}>
										<text
											fg={props.theme.text.feedback.error.base}
											wrapMode="none"
										>
											-{file.deletions ?? 0}
										</text>
									</Show>
									<Show when={!file.patch}>
										<Badge theme={props.theme} label="no diff" tone="muted" />
									</Show>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderFileView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	file: ProviderFile;
}) {
	const syntax = useSyntaxStyle(props.theme);
	let scroll: ScrollBoxRenderable | undefined;
	const lines = () => Math.max(1, props.file.patch.split("\n").length + 1);
	onMount(() => queueMicrotask(() => scroll?.focus()));
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={props.file.path}
				context={`${props.repository} · ${props.provider}`}
				count={0}
			/>
			<box flexDirection="row" gap={1} height={1}>
				<Badge
					theme={props.theme}
					label={props.file.status}
					tone={providerTone(props.file.status)}
				/>
				<Show when={props.file.additions !== undefined}>
					<text fg={props.theme.text.feedback.success.base}>
						+{props.file.additions ?? 0}
					</text>
				</Show>
				<Show when={props.file.deletions !== undefined}>
					<text fg={props.theme.text.feedback.error.base}>
						-{props.file.deletions ?? 0}
					</text>
				</Show>
			</box>
			<scrollbox
				ref={(value: ScrollBoxRenderable) => {
					scroll = value;
				}}
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<Show
					when={props.file.patch.trim()}
					fallback={
						<text fg={props.theme.text.muted}>
							No textual diff for this file.
						</text>
					}
				>
					<diff
						diff={props.file.patch}
						view="unified"
						showLineNumbers
						filetype={filetypeFor(props.file.path)}
						syntaxStyle={syntax}
						wrapMode="word"
						fg={props.theme.text.base}
						contextBg={props.theme.background.base}
						addedSignColor={props.theme.text.feedback.success.base}
						removedSignColor={props.theme.text.feedback.error.base}
						lineNumberFg={props.theme.text.muted}
						lineNumberBg={props.theme.background.base}
						height={lines()}
						width="100%"
					/>
				</Show>
			</scrollbox>
		</box>
	);
}

export function ProviderDiscussionsView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	number: number;
	discussions: readonly ProviderDiscussion[];
	selected: number;
	onSelect(index: number): void;
}) {
	const syntax = useSyntaxStyle(props.theme);
	let scroll: ScrollBoxRenderable | undefined;
	const selectedDiscussion = () =>
		props.discussions[props.selected] ?? props.discussions[0];
	createEffect(() => {
		const discussion = selectedDiscussion();
		if (!scroll || !discussion) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-discussion-${props.selected}`),
		);
	});
	const event = (discussion: ProviderDiscussion) => {
		const body = discussion.body.toLowerCase();
		if (discussion.resolved) return { glyph: "✓", tone: "success" as const };
		if (body.includes("unapproved") || body.includes("removed"))
			return { glyph: "✗", tone: "error" as const };
		if (body.includes("approved"))
			return { glyph: "✓", tone: "success" as const };
		if (body.includes("merged")) return { glyph: "◆", tone: "info" as const };
		if (body.includes("closed"))
			return { glyph: "✕", tone: "warning" as const };
		if (body.includes("reopened")) return { glyph: "○", tone: "info" as const };
		if (body.includes("unassigned"))
			return { glyph: "←", tone: "warning" as const };
		if (body.includes("assigned")) return { glyph: "→", tone: "info" as const };
		if (body.includes("label")) return { glyph: "▣", tone: "warning" as const };
		if (
			body.includes("commit") ||
			body.includes("pushed") ||
			body.includes("added")
		)
			return { glyph: "↑", tone: "info" as const };
		if (body.includes("review")) return { glyph: "?", tone: "info" as const };
		return { glyph: "●", tone: "info" as const };
	};
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={`Timeline #${props.number}`}
				context={`${props.repository} · ${props.provider}`}
				count={props.discussions.length}
			/>
			<Show
				when={props.discussions.length > 0}
				fallback={<text fg={props.theme.text.muted}>No discussions.</text>}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.discussions}>
						{(discussion, index) => {
							const selected = () => index() === props.selected;
							const currentEvent = () => event(discussion);
							return (
								<box
									id={`provider-discussion-${index()}`}
									flexDirection="column"
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<box flexDirection="row" minWidth={0}>
										<text
											width={1}
											flexShrink={0}
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
										>
											{selected() ? "›" : " "}
										</text>
										<box
											width={1}
											flexShrink={0}
											flexDirection="column"
											alignItems="center"
										>
											<text fg={toneColor(props.theme, currentEvent().tone)}>
												{currentEvent().glyph}
											</text>
											<box
												flexGrow={1}
												width={1}
												border={["left"]}
												borderColor={props.theme.text.muted}
											/>
										</box>
										<box
											flexDirection="column"
											flexGrow={1}
											minWidth={0}
											paddingLeft={1}
										>
											<box flexDirection="row" gap={1} height={1}>
												<text
													fg={props.theme.text.feedback.info.base}
													wrapMode="none"
													flexShrink={0}
												>
													{discussion.author || "system"}
												</text>
												<Show when={discussion.createdAt}>
													<text fg={props.theme.text.muted} wrapMode="none">
														{formatTimestamp(
															Date.parse(discussion.createdAt ?? ""),
														)}
													</text>
												</Show>
												<Show when={discussion.resolved !== undefined}>
													<Badge
														theme={props.theme}
														label={discussion.resolved ? "resolved" : "open"}
														tone={discussion.resolved ? "success" : "warning"}
													/>
												</Show>
											</box>
											<markdown
												content={
													providerMarkdown(discussion.body) || "_No content._"
												}
												syntaxStyle={syntax}
												fg={props.theme.text.base}
												streaming
											/>
										</box>
									</box>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderVersionsView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	number: number;
	versions: readonly ProviderVersion[];
	selected: number;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedVersion = () =>
		props.versions[props.selected] ?? props.versions[0];
	createEffect(() => {
		const version = selectedVersion();
		if (!scroll || !version) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`provider-version-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={`Versions #${props.number}`}
				context={`${props.repository} · ${props.provider}`}
				count={props.versions.length}
			/>
			<Show
				when={props.versions.length > 0}
				fallback={<text fg={props.theme.text.muted}>No versions.</text>}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.versions}>
						{(version, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`provider-version-${index()}`}
									flexDirection="column"
									height={2}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<box flexDirection="row" minWidth={0}>
										<text
											width={1}
											flexShrink={0}
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
										>
											{selected() ? "›" : " "}
										</text>
										<box
											width={1}
											flexShrink={0}
											flexDirection="column"
											alignItems="center"
										>
											<text fg={props.theme.text.feedback.info.base}>◆</text>
											<box
												flexGrow={1}
												width={1}
												border={["left"]}
												borderColor={props.theme.text.muted}
											/>
										</box>
										<box
											flexDirection="column"
											flexGrow={1}
											minWidth={0}
											paddingLeft={1}
										>
											<box flexDirection="row" gap={1} height={1}>
												<text
													fg={props.theme.text.feedback.info.base}
													flexShrink={0}
												>
													{version.sha.slice(0, 8)}
												</text>
												<text
													fg={props.theme.text.base}
													wrapMode="none"
													truncate
													flexGrow={1}
													minWidth={0}
												>
													{providerMarkdown(version.message) || "(no message)"}
												</text>
												<Show when={version.date}>
													<text
														fg={props.theme.text.muted}
														wrapMode="none"
														flexShrink={0}
													>
														{formatTimestamp(Date.parse(version.date ?? ""))}
													</text>
												</Show>
											</box>
											<box flexDirection="row" gap={1} height={1}>
												<text fg={props.theme.text.muted} wrapMode="none">
													{version.author || "unknown author"}
												</text>
											</box>
										</box>
									</box>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ProviderIssueView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	issue: ProviderIssueDetail;
}) {
	const syntax = useSyntaxStyle(props.theme);
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={`Issue #${props.issue.number}`}
				context={`${props.repository} · ${props.provider}`}
				count={props.issue.labels.length}
			/>
			<box flexDirection="row" gap={1} height={1} minWidth={0}>
				<text
					fg={props.theme.text.base}
					wrapMode="none"
					truncate
					flexGrow={1}
					minWidth={0}
				>
					{props.issue.title}
				</text>
				<Badge
					theme={props.theme}
					label={props.issue.state}
					tone={providerTone(props.issue.state)}
				/>
			</box>
			<box flexDirection="row" gap={1} height={1} minWidth={0}>
				<Show when={props.issue.author}>
					<text fg={props.theme.text.muted}>{props.issue.author}</text>
				</Show>
				<For each={props.issue.labels.slice(0, 5)}>
					{(label) => <Badge theme={props.theme} label={label} tone="muted" />}
				</For>
			</box>
			<scrollbox
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<markdown
					content={providerMarkdown(props.issue.body) || "_No description._"}
					syntaxStyle={syntax}
					fg={props.theme.text.base}
					streaming
				/>
			</scrollbox>
		</box>
	);
}

export function ProviderJobLogsView(props: {
	theme: Theme;
	provider: string;
	repository: string;
	job: number;
	logs: ProviderJobLogs;
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={`Log job #${props.job}`}
				context={`${props.repository} · ${props.provider}`}
				count={props.logs.truncated ? 1 : 0}
			/>
			<Show when={props.logs.truncated}>
				<text fg={props.theme.text.feedback.warning.base} wrapMode="none">
					Log truncated at 64 KiB.
				</text>
			</Show>
			<scrollbox
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<text fg={props.theme.text.base} wrapMode="none">
					{props.logs.output || "No log output."}
				</text>
			</scrollbox>
		</box>
	);
}

function formatBytes(value: number | undefined) {
	if (value === undefined) return "—";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	if (value < 1024 * 1024 * 1024)
		return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function containerLabel(entry: ContainerStatsEntry) {
	return entry.app ?? entry.service ?? entry.container.slice(0, 12);
}

export function ContainerStatsView(props: {
	theme: Theme;
	stats: ContainerStatsResult;
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Container stats"
				context={props.stats.note}
				count={props.stats.containers.length}
			/>
			<Show when={props.stats.unavailable > 0}>
				<text fg={props.theme.text.feedback.warning.base} wrapMode="none">
					{props.stats.unavailable} container
					{props.stats.unavailable === 1 ? "" : "s"} unavailable.
				</text>
			</Show>
			<Show
				when={props.stats.containers.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						No owned or shared-service containers are running.
					</text>
				}
			>
				<scrollbox
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.stats.containers}>
						{(entry, index) => (
							<box
								id={`container-stats-${index()}`}
								flexDirection="row"
								gap={1}
								height={1}
								paddingLeft={1}
								paddingRight={1}
							>
								<text
									fg={props.theme.text.feedback.info.base}
									wrapMode="none"
									flexShrink={0}
									maxWidth={28}
									truncate
								>
									{containerLabel(entry)}
								</text>
								<text
									fg={props.theme.text.muted}
									wrapMode="none"
									flexShrink={0}
								>
									{entry.provider} {entry.container.slice(0, 12)}
								</text>
								<text
									fg={props.theme.text.base}
									wrapMode="none"
									flexShrink={0}
									minWidth={12}
								>
									CPU {entry.cpuPercent?.toFixed(1) ?? "—"}%
								</text>
								<text
									fg={props.theme.text.base}
									wrapMode="none"
									flexShrink={0}
									minWidth={30}
								>
									MEM {formatBytes(entry.memoryUsageBytes)} /{" "}
									{formatBytes(entry.memoryLimitBytes)}
									{entry.memoryPercent !== undefined
										? ` (${entry.memoryPercent.toFixed(0)}%)`
										: ""}
								</text>
								<text
									fg={props.theme.text.muted}
									wrapMode="none"
									flexShrink={0}
								>
									NET ↓{formatBytes(entry.networkRxBytes)} ↑
									{formatBytes(entry.networkTxBytes)}
								</text>
								<Show when={entry.pids !== undefined}>
									<text
										fg={props.theme.text.muted}
										wrapMode="none"
										flexShrink={0}
									>
										{entry.pids} pids
									</text>
								</Show>
							</box>
						)}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ClustersView(props: {
	theme: Theme;
	clusters: readonly KubernetesClusterInfo[];
	selected: number;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedCluster = () =>
		props.clusters[props.selected] ?? props.clusters[0];
	createEffect(() => {
		const cluster = selectedCluster();
		if (!scroll || !cluster) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`cluster-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Kubernetes clusters"
				context="authorized read-only inspection"
				count={props.clusters.length}
			/>
			<Show
				when={props.clusters.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>
						No Kubernetes clusters are authorized for these repositories.
					</text>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.clusters}>
						{(cluster, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`cluster-${index()}`}
									flexDirection="row"
									gap={1}
									height={1}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<text
										fg={
											selected()
												? props.theme.text.action.primary.base
												: props.theme.text.muted
										}
										flexShrink={0}
									>
										{selected() ? "›" : " "}
									</text>
									<text
										fg={props.theme.text.feedback.info.base}
										wrapMode="none"
										flexShrink={0}
									>
										{cluster.id}
									</text>
									<text
										fg={props.theme.text.base}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{cluster.context}
									</text>
									<text fg={props.theme.text.muted} wrapMode="none">
										{cluster.repositories.length} repos
									</text>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ClusterNamespaceView(props: {
	theme: Theme;
	cluster: KubernetesClusterInfo;
	namespace: string;
	onNamespace(value: string): void;
	onSubmit(): void;
}) {
	let input: InputRenderable | undefined;
	createEffect(() => {
		queueMicrotask(() => input?.focus());
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Inspect namespace"
				context={`${props.cluster.id} · ${props.cluster.context}`}
				count={0}
			/>
			<text fg={props.theme.text.muted} wrapMode="word">
				Read deployments, statefulsets, pods and services. System namespaces are
				refused.
			</text>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={props.theme.text.muted} width={9} flexShrink={0}>
					Namespace
				</text>
				<input
					ref={(value: InputRenderable) => {
						input = value;
					}}
					value={props.namespace}
					placeholder="default"
					focused
					backgroundColor={props.theme.background.base}
					focusedBackgroundColor={props.theme.background.raised.base}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onNamespace}
					onSubmit={props.onSubmit}
					flexGrow={1}
				/>
			</box>
		</box>
	);
}

export function ClusterResourcesView(props: {
	theme: Theme;
	resources: KubernetesResources;
	selected: number;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	const selectedResource = () =>
		props.resources.items[props.selected] ?? props.resources.items[0];
	createEffect(() => {
		const resource = selectedResource();
		if (!scroll || !resource) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`cluster-resource-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Cluster resources"
				context={`${props.resources.cluster} · ${props.resources.namespace}`}
				count={props.resources.items.length}
			/>
			<Show when={props.resources.truncated}>
				<text fg={props.theme.text.feedback.warning.base} wrapMode="none">
					Output truncated.
				</text>
			</Show>
			<Show
				when={props.resources.items.length > 0}
				fallback={
					<scrollbox
						flexGrow={1}
						minHeight={0}
						horizontalScrollbarOptions={{ visible: false }}
					>
						<text fg={props.theme.text.base} wrapMode="none">
							{props.resources.output || "No resources."}
						</text>
					</scrollbox>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.resources.items}>
						{(resource, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`cluster-resource-${index()}`}
									flexDirection="column"
									height={2}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<box flexDirection="row" gap={1} height={1}>
										<text
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
											flexShrink={0}
										>
											{selected() ? "›" : " "}
										</text>
										<text
											fg={props.theme.text.feedback.info.base}
											flexShrink={0}
											width={11}
										>
											{resource.kind}
										</text>
										<text
											fg={props.theme.text.base}
											wrapMode="none"
											truncate
											flexGrow={1}
											minWidth={0}
										>
											{resource.name}
										</text>
										<Show when={resource.ready}>
											<text fg={props.theme.text.muted} flexShrink={0}>
												{resource.ready}
											</text>
										</Show>
										<text
											fg={
												resource.status === "Running" ||
												resource.status === "Ready" ||
												resource.status === "Completed"
													? props.theme.text.feedback.success.base
													: props.theme.text.feedback.warning.base
											}
											flexShrink={0}
										>
											{resource.status}
										</text>
									</box>
									<box flexDirection="row" gap={2} height={1} paddingLeft={3}>
										<Show when={resource.restarts !== undefined}>
											<text fg={props.theme.text.muted} wrapMode="none">
												restarts {resource.restarts}
											</text>
										</Show>
										<Show when={resource.age}>
											<text fg={props.theme.text.muted} wrapMode="none">
												age {resource.age}
											</text>
										</Show>
									</box>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ClusterEventsView(props: {
	theme: Theme;
	events: KubernetesEvents;
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Namespace events"
				context={`${props.events.cluster} · ${props.events.namespace}`}
				count={props.events.events.length}
			/>
			<Show when={props.events.truncated}>
				<text fg={props.theme.text.feedback.warning.base} wrapMode="none">
					Output truncated.
				</text>
			</Show>
			<Show
				when={props.events.events.length > 0}
				fallback={<text fg={props.theme.text.muted}>No events.</text>}
			>
				<scrollbox
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.events.events}>
						{(event: KubernetesEvent) => (
							<box flexDirection="column" paddingLeft={1} paddingRight={1}>
								<box flexDirection="row" gap={1} height={1}>
									<text
										fg={
											event.type === "Warning"
												? props.theme.text.feedback.warning.base
												: props.theme.text.feedback.info.base
										}
										flexShrink={0}
									>
										{event.type === "Warning" ? "▲" : "●"}
									</text>
									<text
										fg={props.theme.text.base}
										flexShrink={0}
										wrapMode="none"
									>
										{event.reason}
									</text>
									<text
										fg={props.theme.text.feedback.info.base}
										wrapMode="none"
										truncate
										flexGrow={1}
										minWidth={0}
									>
										{event.object}
									</text>
									<Show when={event.lastTimestamp}>
										<text fg={props.theme.text.muted} flexShrink={0}>
											{formatTimestamp(Date.parse(event.lastTimestamp ?? ""))}
										</text>
									</Show>
									<Show when={event.count && event.count > 1}>
										<text fg={props.theme.text.muted} flexShrink={0}>
											×{event.count}
										</text>
									</Show>
								</box>
								<box paddingLeft={2}>
									<text fg={props.theme.text.muted} wrapMode="word">
										{event.message || "(no message)"}
									</text>
								</box>
							</box>
						)}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function ClusterDescribeView(props: {
	theme: Theme;
	describe: KubernetesDescribe;
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={`${props.describe.kind} ${props.describe.name}`}
				context={`${props.describe.cluster} · ${props.describe.namespace}`}
				count={0}
			/>
			<Show when={props.describe.truncated}>
				<text fg={props.theme.text.feedback.warning.base} wrapMode="none">
					Output truncated.
				</text>
			</Show>
			<scrollbox
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<text fg={props.theme.text.base} wrapMode="none">
					{props.describe.output || "No output."}
				</text>
			</scrollbox>
		</box>
	);
}

export function ClusterPodLogsView(props: {
	theme: Theme;
	logs: KubernetesPodLogs;
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={`Logs ${props.logs.pod}`}
				context={`${props.logs.cluster} · ${props.logs.namespace}${props.logs.container ? ` · ${props.logs.container}` : ""}`}
				count={0}
			/>
			<Show when={props.logs.truncated}>
				<text fg={props.theme.text.feedback.warning.base} wrapMode="none">
					Output truncated at 128 KiB.
				</text>
			</Show>
			<scrollbox
				flexGrow={1}
				minHeight={0}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<text fg={props.theme.text.base} wrapMode="none">
					{props.logs.output || "No log output."}
				</text>
			</scrollbox>
		</box>
	);
}

export function TagsView(props: {
	theme: Theme;
	tags: GitTags;
	selected: number;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	createEffect(() => {
		const tag = props.tags.tags[props.selected] ?? props.tags.tags[0];
		if (!scroll || !tag) return;
		queueMicrotask(() => scroll?.scrollChildIntoView(`tag-${props.selected}`));
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Tags"
				context={props.tags.repository}
				count={props.tags.tags.length}
			/>
			<Show
				when={props.tags.tags.length > 0}
				fallback={<text fg={props.theme.text.muted}>No tags.</text>}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.tags.tags}>
						{(tag, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`tag-${index()}`}
									flexDirection="column"
									height={2}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<box flexDirection="row" gap={1} height={1}>
										<text
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
											flexShrink={0}
										>
											{selected() ? "›" : " "}
										</text>
										<text
											fg={props.theme.text.feedback.info.base}
											flexShrink={0}
										>
											{tag.annotated ? "◆" : "◇"}
										</text>
										<text
											fg={props.theme.text.base}
											wrapMode="none"
											flexShrink={0}
										>
											{tag.name}
										</text>
										<Show when={tag.annotated}>
											<Badge
												theme={props.theme}
												label="annotated"
												tone="info"
											/>
										</Show>
										<text
											fg={props.theme.text.muted}
											wrapMode="none"
											truncate
											flexGrow={1}
											minWidth={0}
										>
											{tag.subject}
										</text>
										<Show when={tag.date}>
											<text fg={props.theme.text.muted} flexShrink={0}>
												{formatTimestamp(Date.parse(tag.date ?? ""))}
											</text>
										</Show>
									</box>
									<box flexDirection="row" gap={2} height={1} paddingLeft={3}>
										<text fg={props.theme.text.muted} wrapMode="none">
											{tag.sha.slice(0, 8)}
										</text>
									</box>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function StashesView(props: {
	theme: Theme;
	stashes: GitStashes;
	selected: number;
	onSelect(index: number): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	createEffect(() => {
		const stash =
			props.stashes.stashes[props.selected] ?? props.stashes.stashes[0];
		if (!scroll || !stash) return;
		queueMicrotask(() =>
			scroll?.scrollChildIntoView(`stash-${props.selected}`),
		);
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Stashes"
				context={props.stashes.repository}
				count={props.stashes.stashes.length}
			/>
			<Show
				when={props.stashes.stashes.length > 0}
				fallback={<text fg={props.theme.text.muted}>No stashes.</text>}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.stashes.stashes}>
						{(stash, index) => {
							const selected = () => index() === props.selected;
							return (
								<box
									id={`stash-${index()}`}
									flexDirection="column"
									height={2}
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => props.onSelect(index())}
								>
									<box flexDirection="row" gap={1} height={1}>
										<text
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
											flexShrink={0}
										>
											{selected() ? "›" : " "}
										</text>
										<text
											fg={props.theme.text.feedback.info.base}
											flexShrink={0}
										>
											#
										</text>
										<text
											fg={props.theme.text.feedback.info.base}
											flexShrink={0}
										>
											{stash.index}
										</text>
										<Show when={stash.branch}>
											<text
												fg={props.theme.text.muted}
												wrapMode="none"
												flexShrink={0}
											>
												{stash.branch}
											</text>
										</Show>
										<text
											fg={props.theme.text.base}
											wrapMode="none"
											truncate
											flexGrow={1}
											minWidth={0}
										>
											{stash.message || "(no message)"}
										</text>
										<Show when={stash.date}>
											<text fg={props.theme.text.muted} flexShrink={0}>
												{formatTimestamp(Date.parse(stash.date ?? ""))}
											</text>
										</Show>
									</box>
									<box flexDirection="row" gap={2} height={1} paddingLeft={3}>
										<text fg={props.theme.text.muted} wrapMode="none">
											{stash.ref}
										</text>
									</box>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function TagAddView(props: {
	theme: Theme;
	name: string;
	message: string;
	field: number;
	onName(value: string): void;
	onMessage(value: string): void;
	onField(field: number): void;
	onSubmit(): void;
}) {
	let nameInput: InputRenderable | undefined;
	let messageInput: InputRenderable | undefined;
	createEffect(() => {
		if (props.field === 0) queueMicrotask(() => nameInput?.focus());
		else queueMicrotask(() => messageInput?.focus());
	});
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Create tag"
				context="lightweight or annotated"
				count={0}
			/>
			<text fg={props.theme.text.muted} wrapMode="word">
				Leave the message empty for a lightweight tag. Tab switches fields;
				Enter on the message previews the exact intent digest.
			</text>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={props.theme.text.muted} width={9} flexShrink={0}>
					Name
				</text>
				<input
					ref={(value: InputRenderable) => {
						nameInput = value;
					}}
					value={props.name}
					placeholder="v1.2.3"
					focused={props.field === 0}
					backgroundColor={props.theme.background.base}
					focusedBackgroundColor={props.theme.background.raised.base}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onName}
					onSubmit={() => props.onField(1)}
					flexGrow={1}
				/>
			</box>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={props.theme.text.muted} width={9} flexShrink={0}>
					Message
				</text>
				<input
					ref={(value: InputRenderable) => {
						messageInput = value;
					}}
					value={props.message}
					placeholder="optional annotation"
					focused={props.field === 1}
					backgroundColor={props.theme.background.base}
					focusedBackgroundColor={props.theme.background.raised.base}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onMessage}
					onSubmit={props.onSubmit}
					flexGrow={1}
				/>
			</box>
		</box>
	);
}

function gitWriteLabel(action: GitWriteRequest["action"] | undefined) {
	if (action === "push") return "Push branch";
	if (action === "tag") return "Create tag";
	if (action === "tag-delete") return "Delete tag";
	if (action === "stash-pop") return "Pop stash";
	if (action === "stash-apply") return "Apply stash";
	if (action === "stash-drop") return "Drop stash";
	if (action === "branch-rename") return "Rename branch";
	if (action === "remote-set-url") return "Update remote URL";
	if (action === "commit") return "Commit staged changes";
	if (action === "commit-all") return "Commit all changes";
	if (action === "stash") return "Stash changes";
	if (action === "merge") return "Merge branch";
	if (action === "rebase") return "Rebase branch";
	return "Git write";
}

function gitWriteInput(action: GitWriteRequest["action"] | undefined) {
	if (action === "tag") return { label: "Tag", placeholder: "v1.2.3" };
	if (action === "branch-rename")
		return { label: "New name", placeholder: "new-branch" };
	if (action === "remote-set-url")
		return { label: "URL", placeholder: "git@example.invalid:org/repo.git" };
	if (action === "commit" || action === "commit-all")
		return { label: "Message", placeholder: "commit message" };
	if (action === "stash")
		return { label: "Message", placeholder: "optional stash message" };
	return { label: "Value", placeholder: "" };
}

function gitWriteHint(action: GitWriteRequest["action"] | undefined) {
	if (action === "commit")
		return "Only staged changes are committed. Stage paths in Changes first. Enter previews the exact intent digest.";
	if (action === "commit-all")
		return "All changes are staged and committed. Enter previews the exact intent digest.";
	if (action === "push")
		return "No force push is used. Enter previews the exact intent digest.";
	if (action === "merge" || action === "rebase")
		return "The worktree must be clean. Enter previews the exact intent digest.";
	if (action === "stash")
		return "Tracked changes are stashed. Enter previews the exact intent digest.";
	return "Enter previews the exact intent digest. No write occurs until you confirm.";
}

export function GitWriteView(props: {
	theme: Theme;
	action?: GitWriteRequest["action"];
	stage: "edit" | "confirm" | "completed";
	body: string;
	digest?: string;
	target?: string;
	outcome?: GitWriteOutcome;
	onBody(value: string): void;
	onPreview(): void;
}) {
	let input: InputRenderable | undefined;
	createEffect(() => {
		if (props.stage === "edit") queueMicrotask(() => input?.focus());
	});
	const field = () => gitWriteInput(props.action);
	const result = () =>
		props.outcome &&
		(props.outcome.status === "completed" ||
			props.outcome.status === "replayed")
			? props.outcome.outcome
			: undefined;
	const tone = () => {
		const value = result();
		if (!value) return "normal" as const;
		if (value.status === "completed") return "success" as const;
		if (value.status === "refused") return "warning" as const;
		return "error" as const;
	};
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={gitWriteLabel(props.action)}
				context={
					props.stage === "confirm"
						? "review the exact intent digest"
						: props.stage === "completed"
							? "write result"
							: "preview before writing"
				}
				count={result()?.status === "completed" ? 1 : 0}
			/>
			<Show when={props.stage === "edit"}>
				<text fg={props.theme.text.muted} wrapMode="word">
					{gitWriteHint(props.action)}
				</text>
				<box flexDirection="row" gap={1} height={1}>
					<text fg={props.theme.text.muted} width={9} flexShrink={0}>
						{field().label}
					</text>
					<input
						ref={(value: InputRenderable) => {
							input = value;
						}}
						value={props.body}
						placeholder={field().placeholder}
						focused
						backgroundColor={props.theme.background.base}
						focusedBackgroundColor={props.theme.background.raised.base}
						textColor={props.theme.text.base}
						focusedTextColor={props.theme.text.base}
						placeholderColor={props.theme.text.muted}
						cursorColor={props.theme.text.base}
						onInput={props.onBody}
						onSubmit={props.onPreview}
						flexGrow={1}
					/>
				</box>
			</Show>
			<Show when={props.stage === "confirm"}>
				<text fg={props.theme.text.base} wrapMode="word">
					No git command has run. Confirm the digest below to execute the
					action.
				</text>
				<Show when={props.target}>
					<text fg={props.theme.text.base} wrapMode="none">
						{props.target}
					</text>
				</Show>
				<text fg={props.theme.text.feedback.info.base} wrapMode="none">
					{props.digest}
				</text>
				<text fg={props.theme.text.muted} wrapMode="none">
					y confirm · Esc cancel
				</text>
			</Show>
			<Show when={props.stage === "completed"}>
				<Show when={result()}>
					{(outcome) => (
						<>
							<box flexDirection="row" gap={1} height={1}>
								<text
									fg={toneColor(props.theme, tone())}
									wrapMode="none"
									flexShrink={0}
								>
									{outcome().action}
								</text>
								<text
									fg={toneColor(props.theme, tone())}
									wrapMode="none"
									flexShrink={0}
								>
									{outcome().status}
								</text>
								<Show when={outcome().reason}>
									<text fg={props.theme.text.muted} wrapMode="none">
										{outcome().reason}
									</text>
								</Show>
							</box>
							<Show when={props.target}>
								<text fg={props.theme.text.base} wrapMode="none">
									{props.target}
								</text>
							</Show>
							<Show when={outcome().branch}>
								<text fg={props.theme.text.muted} wrapMode="none">
									branch {outcome().branch}
								</text>
							</Show>
							<Show when={outcome().head}>
								<text fg={props.theme.text.muted} wrapMode="none">
									head {outcome().head}
								</text>
							</Show>
							<scrollbox
								flexGrow={1}
								minHeight={0}
								horizontalScrollbarOptions={{ visible: false }}
							>
								<text fg={props.theme.text.base} wrapMode="word">
									{outcome().output || "(no output)"}
								</text>
							</scrollbox>
						</>
					)}
				</Show>
				<text fg={props.theme.text.feedback.info.base} wrapMode="none">
					{props.digest}
				</text>
				<text fg={props.theme.text.muted} wrapMode="none">
					Esc back
				</text>
			</Show>
		</box>
	);
}

function providerWriteLabel(action: ProviderWriteAction | undefined) {
	if (action === "comment-change") return "Comment change";
	if (action === "comment-issue") return "Comment issue";
	if (action === "approve-change") return "Approve change";
	if (action === "merge-change") return "Merge change";
	if (action === "set-issue-state") return "Change issue state";
	if (action === "rebase-change") return "Rebase change";
	if (action === "unapprove-change") return "Withdraw approval";
	if (action === "reply-discussion") return "Reply to discussion";
	if (action === "set-discussion-resolved")
		return "Toggle discussion resolution";
	if (action === "add-labels") return "Add labels";
	if (action === "set-assignees") return "Set assignees";
	if (action === "retry-pipeline") return "Retry pipeline";
	if (action === "retry-job") return "Retry job";
	if (action === "cancel-pipeline") return "Cancel pipeline";
	return "Provider write";
}

function providerWriteInput(action: ProviderWriteAction | undefined) {
	if (action === "add-labels")
		return { label: "Labels", placeholder: "bug, triage" };
	if (action === "set-assignees")
		return { label: "Assignees", placeholder: "alice, bob" };
	if (action === "reply-discussion")
		return { label: "Reply", placeholder: "reply body" };
	return { label: "Body", placeholder: "comment body" };
}

function ConfigInput(props: {
	theme: Theme;
	label: string;
	value: string;
	placeholder: string;
	focused: boolean;
	onInput(value: string): void;
	onSubmit(): void;
	onRef(input: InputRenderable | undefined): void;
}) {
	return (
		<box flexDirection="row" gap={1} height={1}>
			<text fg={props.theme.text.muted} width={12} flexShrink={0}>
				{props.label}
			</text>
			<input
				ref={(value: InputRenderable) => props.onRef(value)}
				value={props.value}
				placeholder={props.placeholder}
				focused={props.focused}
				backgroundColor={props.theme.background.base}
				focusedBackgroundColor={props.theme.background.raised.base}
				textColor={props.theme.text.base}
				focusedTextColor={props.theme.text.base}
				placeholderColor={props.theme.text.muted}
				cursorColor={props.theme.text.base}
				onInput={props.onInput}
				onSubmit={props.onSubmit}
				flexGrow={1}
			/>
		</box>
	);
}

export function ConfigWriteView(props: {
	theme: Theme;
	action?: string;
	stage: "edit" | "confirm" | "completed";
	field: number;
	id: string;
	kind: string;
	repository: string;
	profile: string;
	targetAction: string;
	command: string;
	timeout: string;
	deleteTargets: boolean;
	source?: { app: string; target: string; runtime: string };
	preview?: ConfigurationPreview;
	result?: ConfigurationMutationResult;
	onId(value: string): void;
	onKind(value: string): void;
	onRepository(value: string): void;
	onProfile(value: string): void;
	onTargetAction(value: string): void;
	onCommand(value: string): void;
	onTimeout(value: string): void;
	onPreview(): void;
}) {
	const inputs: (InputRenderable | undefined)[] = [];
	createEffect(() => {
		const field = props.field;
		if (props.stage !== "edit") return;
		queueMicrotask(() => inputs[field]?.focus());
	});
	const input = (index: number) => ({
		onRef: (value: InputRenderable | undefined) => {
			inputs[index] = value;
		},
		focused: props.field === index,
		onSubmit: props.onPreview,
	});
	const title =
		props.action === "app-create"
			? "New application"
			: props.action === "app-edit"
				? "Edit application"
				: props.action === "app-delete"
					? "Delete application"
					: props.action === "target-duplicate"
						? "Duplicate target"
						: props.action === "target-shell"
							? "New shell target"
							: props.action === "target-edit"
								? "Edit target"
								: "Delete target";
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={title}
				context={
					props.stage === "edit"
						? "preview before writing"
						: props.stage === "confirm"
							? "review the exact intent digest"
							: "configuration updated"
				}
				count={props.stage === "completed" ? 1 : 0}
			/>
			<Show when={props.stage === "edit"}>
				<Show when={props.action === "app-create"}>
					<ConfigInput
						theme={props.theme}
						label="ID"
						value={props.id}
						placeholder="my-app"
						{...input(0)}
						onInput={props.onId}
					/>
					<ConfigInput
						theme={props.theme}
						label="Kind"
						value={props.kind}
						placeholder="app | library | infrastructure"
						{...input(1)}
						onInput={props.onKind}
					/>
					<ConfigInput
						theme={props.theme}
						label="Repository"
						value={props.repository}
						placeholder="/absolute/repository"
						{...input(2)}
						onInput={props.onRepository}
					/>
				</Show>
				<Show when={props.action === "app-edit"}>
					<text fg={props.theme.text.muted}>Application {props.id}</text>
					<ConfigInput
						theme={props.theme}
						label="Kind"
						value={props.kind}
						placeholder="app | library | infrastructure"
						{...input(0)}
						onInput={props.onKind}
					/>
					<ConfigInput
						theme={props.theme}
						label="Repository"
						value={props.repository}
						placeholder="/absolute/repository"
						{...input(1)}
						onInput={props.onRepository}
					/>
				</Show>
				<Show when={props.action === "app-delete"}>
					<text fg={props.theme.text.base} wrapMode="word">
						Delete {props.id}? Existing targets require explicit cascade.
					</text>
					<text fg={props.theme.text.feedback.warning.base}>
						t {props.deleteTargets ? "disables" : "enables"} target deletion
					</text>
					<text fg={props.theme.text.muted}>
						{props.deleteTargets
							? "Targets will be deleted with the application."
							: "Targets present will refuse this deletion."}
					</text>
				</Show>
				<Show when={props.action === "target-duplicate"}>
					<text fg={props.theme.text.muted}>
						Source {props.source?.app}/{props.source?.target}
					</text>
					<ConfigInput
						theme={props.theme}
						label="New ID"
						value={props.id}
						placeholder="target-copy"
						{...input(0)}
						onInput={props.onId}
					/>
					<ConfigInput
						theme={props.theme}
						label="Profile"
						value={props.profile}
						placeholder="optional profile label"
						{...input(1)}
						onInput={props.onProfile}
					/>
				</Show>
				<Show when={props.action === "target-shell"}>
					<ConfigInput
						theme={props.theme}
						label="ID"
						value={props.id}
						placeholder="target-id"
						{...input(0)}
						onInput={props.onId}
					/>
					<ConfigInput
						theme={props.theme}
						label="Action"
						value={props.targetAction}
						placeholder="build | test | run"
						{...input(1)}
						onInput={props.onTargetAction}
					/>
					<ConfigInput
						theme={props.theme}
						label="Profile"
						value={props.profile}
						placeholder="optional profile label"
						{...input(2)}
						onInput={props.onProfile}
					/>
					<ConfigInput
						theme={props.theme}
						label="Command"
						value={props.command}
						placeholder="echo hello"
						{...input(3)}
						onInput={props.onCommand}
					/>
					<ConfigInput
						theme={props.theme}
						label="Timeout sec"
						value={props.timeout}
						placeholder="optional"
						{...input(4)}
						onInput={props.onTimeout}
					/>
				</Show>
				<Show when={props.action === "target-edit"}>
					<text fg={props.theme.text.muted}>
						Target {props.source?.app}/{props.source?.target} ·{" "}
						{props.source?.runtime}
					</text>
					<ConfigInput
						theme={props.theme}
						label="Profile"
						value={props.profile}
						placeholder="empty clears the profile"
						{...input(0)}
						onInput={props.onProfile}
					/>
					<ConfigInput
						theme={props.theme}
						label="Action"
						value={props.targetAction}
						placeholder="build | test | run"
						{...input(1)}
						onInput={props.onTargetAction}
					/>
					<Show
						when={
							props.source?.runtime === "shell" ||
							props.source?.runtime === "systemshell"
						}
					>
						<ConfigInput
							theme={props.theme}
							label="Command"
							value={props.command}
							placeholder="leave empty to keep"
							{...input(2)}
							onInput={props.onCommand}
						/>
						<ConfigInput
							theme={props.theme}
							label="Timeout sec"
							value={props.timeout}
							placeholder="leave empty to keep"
							{...input(3)}
							onInput={props.onTimeout}
						/>
					</Show>
				</Show>
				<Show when={props.action === "target-delete"}>
					<text fg={props.theme.text.base} wrapMode="word">
						Delete {props.source?.app}/{props.source?.target}?
					</text>
				</Show>
				<text fg={props.theme.text.muted} wrapMode="none">
					Enter preview · Tab next field · Esc cancel
				</text>
			</Show>
			<Show when={props.stage === "confirm"}>
				<text fg={props.theme.text.base} wrapMode="word">
					No write has been sent. Confirm the exact configuration digest.
				</text>
				<text fg={props.theme.text.feedback.info.base} wrapMode="none">
					{props.preview?.summary}
				</text>
				<text fg={props.theme.text.feedback.info.base} wrapMode="none">
					{props.preview?.confirm}
				</text>
				<text fg={props.theme.text.muted}>y confirm · Esc cancel</text>
			</Show>
			<Show when={props.stage === "completed"}>
				<text fg={props.theme.text.feedback.success.base} wrapMode="word">
					{props.result?.summary}
				</text>
				<text fg={props.theme.text.feedback.info.base} wrapMode="none">
					{props.result?.status === "completed" ? props.result.digest : ""}
				</text>
				<text fg={props.theme.text.muted}>Esc back</text>
			</Show>
		</box>
	);
}

export function ProviderWriteView(props: {
	theme: Theme;
	action?: ProviderWriteAction;
	stage: "edit" | "confirm" | "completed";
	body: string;
	digest?: string;
	receipt?: ProviderWriteReceipt;
	onBody(value: string): void;
	onPreview(): void;
}) {
	let input: InputRenderable | undefined;
	createEffect(() => {
		if (props.stage === "edit") queueMicrotask(() => input?.focus());
	});
	const target = () => props.receipt?.target ?? "";
	const field = () => providerWriteInput(props.action);
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title={providerWriteLabel(props.action)}
				context={
					props.stage === "confirm"
						? "review the exact intent digest"
						: props.stage === "completed"
							? "durable receipt"
							: "preview before writing"
				}
				count={props.receipt?.state === "completed" ? 1 : 0}
			/>
			<Show when={props.stage === "edit"}>
				<text fg={props.theme.text.muted} wrapMode="word">
					Enter previews the exact intent digest. No write occurs until you
					confirm.
				</text>
				<box flexDirection="row" gap={1} height={1}>
					<text fg={props.theme.text.muted} width={9} flexShrink={0}>
						{field().label}
					</text>
					<input
						ref={(value: InputRenderable) => {
							input = value;
						}}
						value={props.body}
						placeholder={field().placeholder}
						focused
						backgroundColor={props.theme.background.base}
						focusedBackgroundColor={props.theme.background.raised.base}
						textColor={props.theme.text.base}
						focusedTextColor={props.theme.text.base}
						placeholderColor={props.theme.text.muted}
						cursorColor={props.theme.text.base}
						onInput={props.onBody}
						onSubmit={props.onPreview}
						flexGrow={1}
					/>
				</box>
			</Show>
			<Show when={props.stage === "confirm"}>
				<text fg={props.theme.text.base} wrapMode="word">
					No write has been sent. Confirm the digest below to perform the
					external action.
				</text>
				<text fg={props.theme.text.feedback.info.base} wrapMode="none">
					{props.digest}
				</text>
				<text fg={props.theme.text.muted} wrapMode="none">
					y confirm · Esc cancel
				</text>
			</Show>
			<Show when={props.stage === "completed"}>
				<text fg={props.theme.text.feedback.success.base} wrapMode="none">
					{props.receipt?.action} {props.receipt?.state}
				</text>
				<text fg={props.theme.text.muted} wrapMode="none">
					{target()}
				</text>
				<text fg={props.theme.text.feedback.info.base} wrapMode="none">
					{props.digest}
				</text>
				<text fg={props.theme.text.base} wrapMode="word">
					{JSON.stringify(props.receipt?.result ?? {}, null, 2)}
				</text>
			</Show>
		</box>
	);
}

export function ProviderWritesView(props: {
	theme: Theme;
	writes: readonly ProviderWriteReceipt[];
}) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<ProviderHeader
				theme={props.theme}
				title="Provider writes"
				context="bounded durable receipts"
				count={props.writes.length}
			/>
			<Show
				when={props.writes.length > 0}
				fallback={
					<text fg={props.theme.text.muted}>No provider writes recorded.</text>
				}
			>
				<scrollbox
					flexGrow={1}
					minHeight={0}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.writes}>
						{(receipt) => (
							<box flexDirection="row" gap={1} height={1}>
								<Badge
									theme={props.theme}
									label={receipt.state}
									tone={
										receipt.state === "completed"
											? "success"
											: receipt.state === "failed"
												? "error"
												: "warning"
									}
								/>
								<text
									fg={props.theme.text.feedback.info.base}
									wrapMode="none"
									flexShrink={0}
								>
									{receipt.action}
								</text>
								<text
									fg={props.theme.text.base}
									wrapMode="none"
									truncate
									flexGrow={1}
									minWidth={0}
								>
									{receipt.target}
								</text>
								<Show when={receipt.error}>
									<text
										fg={props.theme.text.feedback.error.base}
										wrapMode="none"
										flexShrink={0}
									>
										{receipt.error}
									</text>
								</Show>
								<text fg={props.theme.text.muted} wrapMode="none">
									{formatTimestamp(receipt.updatedAt)}
								</text>
							</box>
						)}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}

export function StatusBar(props: {
	theme: Theme;
	view: EnvironmentView;
	message?: string;
	tone?: "normal" | "error" | "warning" | "success";
	right?: string;
	searchFocused?: boolean;
	busy?: boolean;
	panel?: PanelInput;
}) {
	const color = () => {
		if (props.tone === "error") return props.theme.text.feedback.error.base;
		if (props.tone === "warning") return props.theme.text.feedback.warning.base;
		if (props.tone === "success") return props.theme.text.feedback.success.base;
		return props.theme.text.base;
	};
	return (
		<box
			flexShrink={0}
			flexDirection="column"
			backgroundColor={props.theme.background.raised.base}
			paddingLeft={2}
			paddingRight={2}
		>
			<box flexDirection="row" height={1} minWidth={0}>
				<Show when={props.busy}>
					<text fg={props.theme.text.feedback.warning.base} flexShrink={0}>
						working…{" "}
					</text>
				</Show>
				<text fg={color()} wrapMode="none" truncate flexShrink={1}>
					{props.message ?? ""}
				</text>
				<box flexGrow={1} />
				<Show when={props.right}>
					<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
						{props.right}
					</text>
				</Show>
			</box>
			<box flexDirection="row" flexWrap="wrap" columnGap={2}>
				<For each={footerKeybinds(props.view, props.searchFocused)}>
					{(entry) => (
						<text wrapMode="none" flexShrink={0}>
							<span style={{ fg: props.theme.text.base }}>{entry.key}</span>{" "}
							<span style={{ fg: props.theme.text.muted }}>
								{entry.short ?? entry.action}
							</span>
						</text>
					)}
				</For>
				<Show when={props.panel}>
					<text wrapMode="none" flexShrink={0}>
						<span style={{ fg: props.theme.text.base }}>f</span>{" "}
						<span style={{ fg: props.theme.text.muted }}>
							{props.panel?.presentation === "fullscreen"
								? "windowed"
								: "fullscreen"}
						</span>
					</text>
				</Show>
			</box>
			<box height={1} />
		</box>
	);
}

function HelpSectionView(props: { theme: Theme; section: HelpSection }) {
	return (
		<box flexDirection="column" gap={0}>
			<text fg={props.theme.text.feedback.info.base}>
				<b>{props.section.title}</b>
			</text>
			<For each={props.section.entries}>
				{(entry) => (
					<box flexDirection="row" gap={1} minWidth={0}>
						<text
							fg={props.theme.text.base}
							wrapMode="none"
							flexShrink={0}
							width={13}
						>
							{entry.key}
						</text>
						<text fg={props.theme.text.muted} wrapMode="word" flexGrow={1}>
							{entry.action}
						</text>
					</box>
				)}
			</For>
		</box>
	);
}

export function HelpDialog(props: {
	context: Context;
	theme: Theme;
	panel?: PanelInput;
}) {
	onMount(() => props.context.ui.dialog.set({ size: "large" }));
	const sections = () =>
		props.panel
			? [
					...HELP_SECTIONS,
					{
						title: "Panel",
						entries: [
							{ key: "f", action: "toggle fullscreen" },
							{ key: "Esc", action: "close the panel" },
						],
					},
				]
			: HELP_SECTIONS;
	return (
		<box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={props.theme.text.base}>
					<b>environment keys</b>
				</text>
				<text fg={props.theme.text.muted}>esc close</text>
			</box>
			<text fg={props.theme.text.muted} wrapMode="word">
				App-centric environment control. Build, test and run execute directly;
				only resources created by the operation enter cleanup.
			</text>
			<box flexDirection="row" gap={2} alignItems="flex-start">
				<box flexDirection="column" flexGrow={1} minWidth={0} gap={1}>
					<For each={sections().slice(0, 2)}>
						{(section) => (
							<HelpSectionView theme={props.theme} section={section} />
						)}
					</For>
				</box>
				<box flexDirection="column" flexGrow={1} minWidth={0} gap={1}>
					<For each={sections().slice(2)}>
						{(section) => (
							<HelpSectionView theme={props.theme} section={section} />
						)}
					</For>
				</box>
			</box>
		</box>
	);
}
