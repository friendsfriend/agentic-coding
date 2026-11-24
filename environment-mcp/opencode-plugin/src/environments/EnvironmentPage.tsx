/** @jsxImportSource @opentui/solid */
import type { InputRenderable } from "@opentui/core";
import {
	createEffect,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import {
	createEnvironmentApi,
	createEnvironmentEvents,
	errorMessage,
	failingApi,
} from "../client.ts";
import type { Context, PanelInput, Theme } from "../opencode-types.ts";
import { EnvironmentMcpClient } from "./client.ts";
import { type EnvironmentTab, TAB_LABELS, TAB_ORDER } from "./model.ts";
import { createEnvironmentStore } from "./store.ts";
import {
	AppDetail,
	AppTable,
	ChangesView,
	DiffView,
	HelpDialog,
	HistoryView,
	LogsView,
	OperationView,
	ServicesView,
	StatusBar,
	TargetPicker,
	TelemetryView,
} from "./views.tsx";

function Header(props: {
	theme: Theme;
	tab: EnvironmentTab;
	counts: Readonly<Record<EnvironmentTab, number>>;
	historyCount: number;
	serviceCount: number;
	scope: string;
	apps: number;
	owned: number;
	compact: boolean;
	onSelect(tab: EnvironmentTab): void;
}) {
	const count = (tab: EnvironmentTab) =>
		tab === "history"
			? props.historyCount
			: tab === "services"
				? props.serviceCount
				: props.counts[tab];
	const label = (tab: EnvironmentTab) =>
		props.compact
			? (
					{
						applications: "Apps",
						libraries: "Libs",
						infrastructure: "Infra",
						history: "Hist",
						services: "Svc",
					} as const
				)[tab]
			: TAB_LABELS[tab];
	return (
		<box
			flexShrink={0}
			flexDirection="column"
			backgroundColor={props.theme.background.raised.base}
			paddingLeft={props.compact ? 1 : 2}
			paddingRight={props.compact ? 1 : 2}
			paddingTop={1}
			paddingBottom={1}
			gap={1}
		>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>environments</b>
				</text>
				<text fg={props.theme.text.feedback.success.base}>●</text>
				<text fg={props.theme.text.feedback.success.base} wrapMode="none">
					{props.scope}
				</text>
				<box flexGrow={1} />
				<Show when={!props.compact}>
					<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
						{props.apps} apps · {props.owned} owned
					</text>
				</Show>
			</box>
			<box flexDirection="row" gap={2} flexWrap="wrap">
				<For each={TAB_ORDER}>
					{(tab, index) => {
						const selected = () => tab === props.tab;
						return (
							<box
								flexShrink={0}
								paddingLeft={1}
								paddingRight={1}
								backgroundColor={
									selected()
										? props.theme.background.action.primary.focused
										: undefined
								}
								onMouseUp={() => props.onSelect(tab)}
							>
								<text
									wrapMode="none"
									fg={
										selected()
											? props.theme.text.action.primary.focused
											: props.theme.text.muted
									}
								>
									{index() + 1} {label(tab)}
									{props.compact ? ` ${count(tab)}` : ` (${count(tab)})`}
								</text>
							</box>
						);
					}}
				</For>
			</box>
		</box>
	);
}

export function EnvironmentPage(props: {
	context: Context;
	onClose: () => void;
	panel?: PanelInput;
}) {
	const theme = props.context.theme;
	const compact = () => Boolean(props.panel) && (props.panel?.width ?? 0) < 96;
	const active = () => !props.panel || props.panel.focused;
	const api = (() => {
		try {
			return createEnvironmentApi(props.context.options);
		} catch (error) {
			return failingApi(errorMessage(error));
		}
	})();
	const client = new EnvironmentMcpClient(api);
	const events = (() => {
		try {
			return createEnvironmentEvents(props.context.options);
		} catch {
			return undefined;
		}
	})();
	const eventsController = new AbortController();
	const store = createEnvironmentStore(client);
	onCleanup(() => eventsController.abort());
	createEffect(() => {
		if (store.view() === "table" || store.view() === "detail") {
			store.startLiveRefresh();
		} else {
			store.stopLiveRefresh();
		}
	});
	let searchInput: InputRenderable | undefined;

	const focusSearch = () => {
		if (store.view() !== "table") return;
		store.setSearchFocused(true);
		queueMicrotask(() => searchInput?.focus());
	};
	const blurSearch = () => {
		store.setSearchFocused(false);
		searchInput?.blur();
	};
	const finishSearch = () => {
		blurSearch();
	};
	const clearSearch = () => {
		blurSearch();
		store.setQuery("");
		store.setSelectedIndex(0);
	};
	const back = () => {
		if (store.searchFocused()) {
			clearSearch();
			return;
		}
		if (store.view() === "table") {
			props.onClose();
			return;
		}
		store.back();
	};
	const openHelp = () => {
		props.context.ui.dialog.set({ size: "large" });
		props.context.ui.dialog.show(() => (
			<HelpDialog context={props.context} theme={theme} panel={props.panel} />
		));
	};
	const refresh = () => {
		void store.refresh();
	};
	const selectedApp = () => store.selectedApp();
	const message = () => {
		if (store.error()) return store.error();
		if (store.message()) return store.message();
		if (store.busy()) return "Working…";
		if (store.view() === "table")
			return `${store.filteredApps().length} of ${store.tabApps().length} applications`;
		if (store.view() === "detail" && selectedApp())
			return `${selectedApp()?.id} · ${selectedApp()?.kind}`;
		if (store.view() === "operation" && store.operation())
			return `operation ${store.operation()?.state}`;
		if (store.view() === "history")
			return `${store.operations().length} of ${store.operationTotal()} receipts`;
		if (store.view() === "services")
			return `${store.services().length} configured services`;
		return "";
	};
	const tone = () => {
		if (store.error()) return "error" as const;
		if (store.busy()) return "warning" as const;
		if (store.operation()?.state === "completed") return "success" as const;
		return "normal" as const;
	};
	const right = () => {
		if (store.view() === "table")
			return `${store.filteredApps().length}/${store.tabApps().length}`;
		if (store.view() === "detail" && selectedApp()) return selectedApp()?.id;
		if (store.view() === "changes" && selectedApp()) return selectedApp()?.id;
		if (store.view() === "diff" && selectedApp()) return selectedApp()?.id;
		if (store.view() === "operation" && store.operation())
			return store.operation()?.id.slice(0, 12);
		if (store.view() === "history")
			return `${store.operations().length}/${store.operationTotal()}`;
		if (store.view() === "telemetry")
			return `${store.telemetry()?.traces.length ?? 0} traces`;
		return undefined;
	};

	onMount(() => {
		if (props.panel) queueMicrotask(() => props.panel?.focus());
		void events?.subscribe(eventsController.signal, store.handleEvent);
		void store.load();
	});

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: active,
		commands: [
			{ bind: "escape", title: "Back", group: "Environments", run: back },
			{
				bind: "?",
				title: "Environment help",
				group: "Environments",
				enabled: () => !store.searchFocused(),
				run: openHelp,
			},
			{
				bind: "r",
				title: "Refresh",
				group: "Environments",
				enabled: () => !store.searchFocused(),
				run: refresh,
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() && !store.searchFocused() && store.view() !== "operation",
		commands: [
			{
				bind: "tab",
				title: "Next tab",
				group: "Environments",
				run: () => store.cycleTab(1),
			},
			{
				bind: "shift+tab",
				title: "Previous tab",
				group: "Environments",
				run: () => store.cycleTab(-1),
			},
			{
				bind: "1",
				title: "Applications",
				group: "Environments",
				run: () => store.selectTab("applications"),
			},
			{
				bind: "2",
				title: "Libraries",
				group: "Environments",
				run: () => store.selectTab("libraries"),
			},
			{
				bind: "3",
				title: "Infrastructure",
				group: "Environments",
				run: () => store.selectTab("infrastructure"),
			},
			{
				bind: "4",
				title: "History",
				group: "Environments",
				run: () => store.selectTab("history"),
			},
			{
				bind: "5",
				title: "Services",
				group: "Environments",
				run: () => store.selectTab("services"),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() &&
			!store.searchFocused() &&
			(store.view() === "table" ||
				store.view() === "targets" ||
				store.view() === "history" ||
				store.view() === "telemetry"),
		commands: [
			{
				bind: "up,k",
				title: "Previous",
				group: "Environments",
				run: () => store.move(-1),
			},
			{
				bind: "down,j",
				title: "Next",
				group: "Environments",
				run: () => store.move(1),
			},
			{
				bind: "return",
				title: "Open",
				group: "Environments",
				run: store.openSelected,
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() && store.view() === "table" && store.searchFocused(),
		commands: [
			{
				bind: "up",
				title: "Previous filtered result",
				group: "Environments",
				run: () => store.move(-1),
			},
			{
				bind: "down",
				title: "Next filtered result",
				group: "Environments",
				run: () => store.move(1),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() && store.view() === "table" && !store.searchFocused(),
		commands: [
			{ bind: "/", title: "Filter", group: "Environments", run: focusSearch },
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "detail",
		commands: [
			{
				bind: "b",
				title: "Build",
				group: "Environments",
				run: () => store.openTargets("build"),
			},
			{
				bind: "s",
				title: "Start / run",
				group: "Environments",
				run: () => store.openTargets("run"),
			},
			{
				bind: "t",
				title: "Test",
				group: "Environments",
				run: () => store.openTargets("test"),
			},
			{
				bind: "shift+s",
				title: "Stop owned resources",
				group: "Environments",
				run: () => void store.stop(),
			},
			{
				bind: "c",
				title: "Changes",
				group: "Environments",
				run: () => {
					const app = selectedApp();
					if (app) void store.loadChanges(app);
				},
			},
			{
				bind: "l",
				title: "Logs",
				group: "Environments",
				run: () => {
					const app = selectedApp();
					if (app) void store.loadLogs(app);
				},
			},
			{
				bind: "shift+l",
				title: "History",
				group: "Environments",
				run: () => store.selectTab("history"),
			},
			{
				bind: "e",
				title: "Telemetry",
				group: "Environments",
				run: () => {
					const app = selectedApp();
					if (app) void store.loadTelemetry(app);
				},
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "operation",
		commands: [
			{
				bind: "r",
				title: "Refresh operation",
				group: "Environments",
				run: () => void store.refreshOperation(),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "changes",
		commands: [
			{
				bind: "up,k",
				title: "Previous change",
				group: "Environments",
				run: () => store.moveChange(-1),
			},
			{
				bind: "down,j",
				title: "Next change",
				group: "Environments",
				run: () => store.moveChange(1),
			},
			{
				bind: "enter",
				title: "Open diff",
				group: "Environments",
				run: () => void store.openSelectedChange(),
			},
			{
				bind: "r",
				title: "Refresh changes",
				group: "Environments",
				run: () => void store.refreshChanges(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "diff",
		commands: [
			{
				bind: "r",
				title: "Reload diff",
				group: "Environments",
				run: () => void store.reloadDiff(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => Boolean(props.panel?.focused) && !store.searchFocused(),
		commands: [
			{
				bind: "f",
				title: "Toggle fullscreen",
				group: "Environments",
				run: () => props.panel?.toggleFullscreen(),
			},
		],
	}));

	return (
		<box
			width="100%"
			height="100%"
			flexDirection="column"
			backgroundColor={theme.background.base}
		>
			<Header
				theme={theme}
				tab={store.tab()}
				counts={store.counts()}
				historyCount={store.operationTotal()}
				serviceCount={store.services().length}
				scope={store.scope()}
				apps={store.appTotal()}
				owned={store.owned().length}
				compact={compact()}
				onSelect={store.selectTab}
			/>
			<box
				flexGrow={1}
				flexDirection="column"
				minHeight={0}
				paddingLeft={compact() ? 1 : 2}
				paddingRight={compact() ? 1 : 2}
				paddingTop={1}
			>
				<Switch>
					<Match when={store.view() === "table"}>
						<AppTable
							theme={theme}
							apps={store.tabApps()}
							owned={store.owned()}
							git={store.git()}
							active={store.activeApps()}
							scope={store.scope()}
							selected={store.selectedIndex()}
							query={store.query()}
							searchFocused={store.searchFocused()}
							compact={compact()}
							onQuery={(value) => {
								store.setQuery(value);
								store.setSelectedIndex(0);
							}}
							onSelect={store.setSelectedIndex}
							onOpen={store.openSelected}
							onSearchSubmit={finishSearch}
							onSearchRef={(input) => {
								searchInput = input;
							}}
							onFocusSearch={() => store.setSearchFocused(true)}
							onBlurSearch={() => store.setSearchFocused(false)}
						/>
					</Match>
					<Match when={store.view() === "detail"}>
						<Show
							when={selectedApp()}
							fallback={
								<text fg={theme.text.muted}>No application selected.</text>
							}
						>
							{(app) => (
								<AppDetail
									theme={theme}
									app={app()}
									status={store.status()}
									owned={store.owned()}
									git={store.git()}
									active={store.activeApps()}
									operations={store.operations()}
									subjects={store.subjectFor}
									onExecute={(action, target) =>
										void store.executeTarget(action, target)
									}
									onStop={() => void store.stop()}
									onLogs={() => void store.loadLogs(app())}
									onHistory={() => store.selectTab("history")}
									onTelemetry={() => void store.loadTelemetry(app())}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "targets"}>
						<Show when={selectedApp()}>
							{(app) => (
								<TargetPicker
									theme={theme}
									app={app()}
									action={store.targetAction()}
									targets={store.targetList()}
									selected={store.targetIndex()}
									onSelect={store.setTargetIndex}
									onOpen={store.openSelected}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "history"}>
						<HistoryView
							theme={theme}
							operations={store.operations()}
							total={store.operationTotal()}
							selected={store.historyIndex()}
							subjects={store.subjectFor}
							onSelect={store.setHistoryIndex}
							onOpen={store.openSelected}
						/>
					</Match>
					<Match when={store.view() === "operation"}>
						<Show when={store.operation()}>
							{(operation) => (
								<OperationView
									theme={theme}
									context={props.context}
									active={active}
									operation={operation()}
									progress={store.progress()}
									receipt={store.receipt()}
									subject={store.operationSubject()}
									onRefresh={() => void store.refreshOperation()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "changes"}>
						<Show when={store.changes()}>
							{(changes) => (
								<Show when={selectedApp()}>
									{(app) => (
										<ChangesView
											theme={theme}
											app={app()}
											changes={changes()}
											selected={store.changeIndex()}
											onSelect={store.setChangeIndex}
											onOpen={() => void store.openSelectedChange()}
										/>
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "diff"}>
						<Show when={store.diff()}>
							{(diff) => (
								<Show when={selectedApp()}>
									{(app) => (
										<DiffView theme={theme} app={app()} diff={diff()} />
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "logs"}>
						<Show when={selectedApp()}>
							{(app) => (
								<Show when={store.logs()}>
									{(logs) => (
										<LogsView
											theme={theme}
											app={app()}
											logs={logs()}
											onReload={() => void store.loadLogs(app())}
										/>
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "telemetry"}>
						<Show when={selectedApp()}>
							{(app) => (
								<Show when={store.telemetry()}>
									{(telemetry) => (
										<TelemetryView
											theme={theme}
											app={app()}
											telemetry={telemetry()}
											traceId={store.traceId()}
											selectedTraceIndex={store.traceIndex()}
											onSelectTrace={store.setTraceIndex}
											onOpenTrace={(trace) =>
												void store.openTrace(trace.traceId)
											}
										/>
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "services"}>
						<ServicesView theme={theme} services={store.services()} />
					</Match>
				</Switch>
			</box>
			<box height={1} flexShrink={0} />
			<StatusBar
				theme={theme}
				view={store.view()}
				message={message()}
				tone={tone()}
				right={right()}
				searchFocused={store.searchFocused()}
				busy={store.busy()}
				panel={props.panel}
			/>
		</box>
	);
}
