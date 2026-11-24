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
import {
	actionGlyph,
	type EnvironmentApp,
	type EnvironmentService,
	type EnvironmentStatus,
	type EnvironmentTarget,
	type EnvironmentView,
	type ExecutionReceipt,
	filterApps,
	formatTimestamp,
	type GitChange,
	type GitChanges,
	type GitDiff,
	type GitStatus,
	type LogsSnapshot,
	type OperationDetail,
	type OperationSubject,
	type OperationSummary,
	type OwnedResource,
	ownedFor,
	prettyJson,
	receiptText,
	scopeLabel,
	shortId,
	type TelemetrySnapshot,
	type TelemetryTrace,
	targetLabel,
	targetSummary,
} from "./model.ts";

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
	scope: string;
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
				paddingTop={1}
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
				<box flexDirection="row" gap={2}>
					<text fg={props.theme.text.muted}>
						{visible().length} of {props.apps.length} shown
					</text>
					<text fg={props.theme.text.muted}>scope: {props.scope}</text>
					<text fg={props.theme.text.muted}>owned: {props.owned.length}</text>
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
					verticalScrollbarOptions={{ visible: false }}
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
					verticalScrollbarOptions={{ visible: false }}
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
				verticalScrollbarOptions={{ visible: false }}
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

export function AppDetail(props: {
	theme: Theme;
	app: EnvironmentApp;
	status: EnvironmentStatus;
	owned: readonly OwnedResource[];
	git: ReadonlyMap<string, GitStatus>;
	active: ReadonlyMap<string, { action?: string }>;
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
				verticalScrollbarOptions={{ visible: false }}
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
					verticalScrollbarOptions={{ visible: false }}
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
					verticalScrollbarOptions={{ visible: false }}
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
				verticalScrollbarOptions={{ visible: false }}
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
					verticalScrollbarOptions={{ visible: false }}
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
						verticalScrollbarOptions={{ visible: false }}
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
											verticalScrollbarOptions={{ visible: false }}
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
						verticalScrollbarOptions={{ visible: false }}
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
				verticalScrollbarOptions={{ visible: false }}
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
				verticalScrollbarOptions={{ visible: false }}
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
						verticalScrollbarOptions={{ visible: false }}
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
					verticalScrollbarOptions={{ visible: false }}
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
