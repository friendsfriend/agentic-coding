/** @jsxImportSource @opentui/solid */
import type { InputRenderable, SelectRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import {
	createEnvironmentUiController,
	type EnvironmentUiSnapshot,
} from "../../src/ui/controller.ts";
import { filterActions, groupActions } from "./catalog.ts";
import { createEnvironmentApi, errorMessage, failingApi } from "./client.ts";
import { ActionDetail } from "./components/ActionDetail.tsx";
import { ActionForm } from "./components/ActionForm.tsx";
import { ActionList } from "./components/ActionList.tsx";
import { HelpDialog } from "./components/HelpDialog.tsx";
import { ResultView } from "./components/ResultView.tsx";
import {
	ErrorView,
	LoadingView,
	RunningView,
} from "./components/StateViews.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TraceView } from "./components/TraceView.tsx";
import type { Context, Theme } from "./opencode-types.ts";

function Header(props: {
	theme: Theme;
	view: EnvironmentUiSnapshot["view"];
	count: number;
	compact: boolean;
}) {
	const status = () => {
		switch (props.view) {
			case "error":
				return {
					label: "error",
					color: props.theme.text.feedback.error.base,
				};
			case "loading":
				return {
					label: "connecting",
					color: props.theme.text.feedback.warning.base,
				};
			case "running":
				return {
					label: "working",
					color: props.theme.text.feedback.warning.base,
				};
			default:
				return {
					label: "connected",
					color: props.theme.text.feedback.success.base,
				};
		}
	};
	return (
		<box
			flexShrink={0}
			flexDirection="column"
			backgroundColor={props.theme.background.raised.base}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
			paddingBottom={1}
		>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>environment</b>
				</text>
				<text fg={status().color} wrapMode="none">
					●
				</text>
				<text fg={status().color} wrapMode="none">
					{status().label}
				</text>
				<box flexGrow={1} />
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.count} capabilit{props.count === 1 ? "y" : "ies"}
				</text>
			</box>
			<Show when={!props.compact}>
				<text fg={props.theme.text.muted} wrapMode="none" truncate>
					owned builds, services and telemetry · no borrowed cleanup
				</text>
			</Show>
		</box>
	);
}

export function EnvironmentPage(props: {
	context: Context;
	onClose: () => void;
}) {
	const theme = props.context.theme;
	const dimensions = useTerminalDimensions();
	const compact = () => dimensions().width < 80;

	const api = (() => {
		try {
			return createEnvironmentApi(props.context.options);
		} catch (error) {
			return failingApi(errorMessage(error));
		}
	})();
	const controller = createEnvironmentUiController(api);

	const [snapshot, setSnapshot] = createSignal(controller.getSnapshot());
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	const [searchFocused, setSearchFocused] = createSignal(false);
	const [fieldIndex, setFieldIndex] = createSignal(0);
	let searchInput: InputRenderable | undefined;
	const inputRefs: Array<InputRenderable | undefined> = [];
	const selectRefs: Array<SelectRenderable | undefined> = [];

	const view = () => snapshot().view;
	const actions = () => snapshot().actions;
	const visibleActions = createMemo(() => filterActions(actions(), query()));
	const groups = createMemo(() => groupActions(visibleActions()));
	const selectedAction = createMemo(
		() => visibleActions()[selected()] ?? visibleActions()[0],
	);
	const currentAction = () => snapshot().action;
	const rightLabel = () =>
		view() === "list"
			? `${visibleActions().length}/${actions().length}`
			: currentAction()?.name;

	const blurSearch = () => {
		setSearchFocused(false);
		searchInput?.blur();
	};

	const focusSearch = () => {
		if (view() !== "list") return;
		setSearchFocused(true);
		queueMicrotask(() => searchInput?.focus());
	};

	const selectAction = (index: number) => {
		setSelected(index);
		blurSearch();
	};

	const move = (delta: number) => {
		const count = visibleActions().length;
		if (!count) return;
		setSelected((current) => (current + delta + count) % count);
	};

	const openSelected = () => {
		if (view() !== "list") return;
		const action = selectedAction();
		if (!action) return;
		const fullIndex = actions().findIndex(
			(candidate) => candidate.name === action.name,
		);
		if (fullIndex < 0) return;
		blurSearch();
		controller.select(fullIndex);
		controller.openSelected();
		setFieldIndex(0);
	};

	const back = () => {
		if (searchFocused()) {
			blurSearch();
			if (query()) setQuery("");
			return;
		}
		if (view() === "list" || view() === "loading") {
			props.onClose();
			return;
		}
		if (view() === "running") {
			controller.cancel();
			return;
		}
		controller.back();
	};

	const focusField = (index: number) => {
		const count = snapshot().fields.length;
		if (!count) return;
		const next = Math.max(0, Math.min(count - 1, index));
		setFieldIndex(next);
		queueMicrotask(() => {
			inputRefs[next]?.focus();
			selectRefs[next]?.focus();
		});
	};

	const advanceField = (index: number) => {
		if (index >= snapshot().fields.length - 1) {
			void controller.submit();
			return;
		}
		focusField(index + 1);
	};

	const openHelp = () => {
		props.context.ui.dialog.set({ size: "large" });
		props.context.ui.dialog.show(() => (
			<HelpDialog context={props.context} theme={theme} />
		));
	};

	const moveTrace = (delta: number) => controller.moveTrace(delta);
	const openTrace = () => {
		void controller.openTrace();
	};

	onMount(() => {
		const unsubscribe = controller.subscribe(() =>
			setSnapshot(controller.getSnapshot()),
		);
		void controller.load();
		onCleanup(unsubscribe);
	});

	createEffect(
		on(
			() => [snapshot().view, snapshot().action?.name] as const,
			([view, actionName]) => {
				if (view !== "list") return;
				setSearchFocused(false);
				if (!actionName) return;
				const index = visibleActions().findIndex(
					(candidate) => candidate.name === actionName,
				);
				if (index >= 0) setSelected(index);
			},
		),
	);

	createEffect(
		on(
			() => snapshot().view,
			(view) => {
				if (view !== "form") return;
				setFieldIndex(0);
				queueMicrotask(() => focusField(0));
			},
		),
	);

	createEffect(() => {
		const count = visibleActions().length;
		setSelected((current) => Math.min(current, Math.max(0, count - 1)));
	});

	props.context.keymap.layer(() => ({
		priority: 1,
		commands: [
			{
				bind: "escape",
				title: "Back",
				group: "Environment",
				run: back,
			},
			{
				bind: "?",
				title: "Environment help",
				group: "Environment",
				enabled: () => view() !== "form" && !searchFocused(),
				run: openHelp,
			},
			{
				bind: "r",
				title: "Refresh capabilities",
				group: "Environment",
				enabled: () =>
					!searchFocused() && (view() === "list" || view() === "error"),
				run: () => void controller.load(),
			},
			{
				bind: "/",
				title: "Filter capabilities",
				group: "Environment",
				enabled: () => view() === "list" && !searchFocused(),
				run: focusSearch,
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1,
		enabled: () => view() === "list" && !searchFocused(),
		commands: [
			{
				bind: "up,k",
				title: "Previous capability",
				group: "Environment",
				run: () => move(-1),
			},
			{
				bind: "down,j",
				title: "Next capability",
				group: "Environment",
				run: () => move(1),
			},
			{
				bind: "return",
				title: "Open capability",
				group: "Environment",
				run: openSelected,
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1,
		enabled: () => view() === "form",
		commands: [
			{
				bind: "tab",
				title: "Next field",
				group: "Environment",
				run: () => focusField(fieldIndex() + 1),
			},
			{
				bind: "shift+tab",
				title: "Previous field",
				group: "Environment",
				run: () => focusField(fieldIndex() - 1),
			},
			{
				bind: "ctrl+return",
				title: "Run capability",
				group: "Environment",
				run: () => void controller.submit(),
			},
			{
				bind: "return",
				title: "Run capability",
				group: "Environment",
				enabled: () => snapshot().fields.length === 0,
				run: () => void controller.submit(),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1,
		enabled: () => view() === "traces",
		commands: [
			{
				bind: "up,k",
				title: "Previous trace",
				group: "Environment",
				run: () => moveTrace(-1),
			},
			{
				bind: "down,j",
				title: "Next trace",
				group: "Environment",
				run: () => moveTrace(1),
			},
			{
				bind: "return",
				title: "Open trace",
				group: "Environment",
				run: openTrace,
			},
		],
	}));

	const tone = () => {
		if (view() === "error") return "error" as const;
		if (view() === "running") return "warning" as const;
		if (view() === "result") return "success" as const;
		return "normal" as const;
	};

	return (
		<box
			width="100%"
			height="100%"
			flexDirection="column"
			backgroundColor={theme.background.base}
		>
			<Header
				theme={theme}
				view={view()}
				count={actions().length}
				compact={compact()}
			/>
			<box flexGrow={1} flexDirection="row" minHeight={0}>
				<Show when={!compact() || view() === "list" || view() === "loading"}>
					<ActionList
						theme={theme}
						actions={visibleActions()}
						groups={groups()}
						selected={selected()}
						query={query()}
						searchFocused={searchFocused()}
						compact={compact()}
						onQuery={(value) => {
							setQuery(value);
							setSelected(0);
						}}
						onSelect={selectAction}
						onOpen={openSelected}
						onFocusSearch={() => setSearchFocused(true)}
						onBlurSearch={() => setSearchFocused(false)}
						onSearchRef={(input) => {
							searchInput = input;
						}}
					/>
				</Show>
				<Show when={!compact() || (view() !== "list" && view() !== "loading")}>
					<box
						flexGrow={1}
						minWidth={0}
						minHeight={0}
						flexDirection="column"
						paddingLeft={2}
						paddingRight={2}
						paddingTop={1}
					>
						<Switch>
							<Match when={view() === "list"}>
								<Show
									when={selectedAction()}
									fallback={
										<text fg={theme.text.muted}>No capability selected.</text>
									}
								>
									{(action) => <ActionDetail theme={theme} action={action()} />}
								</Show>
							</Match>
							<Match when={view() === "form"}>
								<Show when={currentAction()}>
									{(action) => (
										<ActionForm
											theme={theme}
											action={action()}
											fields={snapshot().fields}
											values={snapshot().values}
											fieldIndex={fieldIndex()}
											message={snapshot().message}
											onValue={(name, value) =>
												controller.setValue(name, value)
											}
											onFocusField={setFieldIndex}
											onAdvance={advanceField}
											onInputRef={(index, input) => {
												inputRefs[index] = input;
											}}
											onSelectRef={(index, select) => {
												selectRefs[index] = select;
											}}
										/>
									)}
								</Show>
							</Match>
							<Match when={view() === "running"}>
								<Show
									when={currentAction()}
									fallback={<RunningView theme={theme} label="request" />}
								>
									{(action) => (
										<RunningView theme={theme} label={action().label} />
									)}
								</Show>
							</Match>
							<Match when={view() === "traces"}>
								<Show when={currentAction()}>
									{(action) => (
										<TraceView
											theme={theme}
											action={action()}
											summary={snapshot().result ?? ""}
											traces={snapshot().traces ?? []}
											traceIndex={snapshot().traceIndex}
											onSelect={(index) => controller.selectTrace(index)}
											onOpen={openTrace}
										/>
									)}
								</Show>
							</Match>
							<Match when={view() === "result"}>
								<Show when={currentAction()}>
									{(action) => (
										<ResultView
											theme={theme}
											action={action()}
											result={snapshot().result ?? ""}
										/>
									)}
								</Show>
							</Match>
							<Match when={view() === "error"}>
								<ErrorView theme={theme} message={snapshot().message} />
							</Match>
							<Match when={view() === "loading"}>
								<LoadingView theme={theme} />
							</Match>
						</Switch>
					</box>
				</Show>
			</box>
			<StatusBar
				theme={theme}
				view={view()}
				message={snapshot().message}
				tone={tone()}
				right={rightLabel()}
				searchFocused={searchFocused()}
			/>
		</box>
	);
}
