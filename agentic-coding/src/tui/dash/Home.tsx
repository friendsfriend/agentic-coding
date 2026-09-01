/** @jsxImportSource @opentui/solid */

import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { phase } from "../lifecycle";
import {
	focusWorkflow,
	herdrAvailable,
	isStale,
	listPresetNames,
	notifyHerdrError,
	startWorkflow,
	type WorkflowOverview,
} from "./data";
import { notify } from "./notifications";
import { invokeGlobalSelectionMouseUpHandler } from "./selectionCopy";
import { applyTheme, loadThemeName, saveThemeName } from "./theme-settings";
import { uiColors } from "./ui/colors";
import { ErrorDialog } from "./ui/ErrorDialog";
import { FilterModal } from "./ui/FilterModal";
import { HelpModal, type HelpSection } from "./ui/HelpModal";
import { ModelConfigModal } from "./ui/ModelConfigModal";
import { NewWorkflowModal } from "./ui/NewWorkflowModal";
import { NotificationOverlay } from "./ui/Notification";
import { Panel } from "./ui/Panel";
import { SelectableList } from "./ui/Selectable";
import { SortModal } from "./ui/SortModal";
import { ThemePickerModal } from "./ui/ThemePickerModal";
import { getActiveThemeName, themeNames } from "./ui/theme";

export function Home(props: {
	keymap: Keymap<Renderable, KeyEvent>;
	items: WorkflowOverview[];
	loading: boolean;
	projects: Array<{ name: string; path: string; openspec: boolean }>;
	refresh: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const [projects, setProjects] = createSignal<
		Array<{ name: string; path: string; openspec: boolean }>
	>([]);
	const [items, setItems] = createSignal<WorkflowOverview[]>([]);
	const [loading, setLoading] = createSignal(true);
	// The shell owns the workspace list (background load/refresh, survives tab
	// switches); this tab content just mirrors it.
	createEffect(() => setItems(props.items));
	createEffect(() => setProjects(props.projects));
	createEffect(() => setLoading(props.loading));
	const [selected, setSelected] = createSignal(0);
	const [modal, setModal] = createSignal(false);
	const [modalHandler, setModalHandler] =
		createSignal<(event: KeyEvent) => boolean>();
	const [workflowPresets, setWorkflowPresets] = createSignal<string[]>([]);
	const [modelConfig, setModelConfig] = createSignal(false);
	const [modelConfigHandler, setModelConfigHandler] =
		createSignal<(event: KeyEvent) => boolean>();
	const [_message, setMessage] = createSignal("");
	const [error, setError] = createSignal<{ title: string; message: string }>();
	const [help, setHelp] = createSignal(false);
	const [helpOffset, setHelpOffset] = createSignal(0);
	let errorScroll: { scrollBy(dy: number): void } | undefined;
	const [themePicker, setThemePicker] = createSignal(false);
	const [themeIndex, setThemeIndex] = createSignal(
		Math.max(0, themeNames.indexOf(loadThemeName())),
	);
	const [filterModal, setFilterModal] = createSignal(false);
	const [filterFocusedPane, setFilterFocusedPane] = createSignal<
		"parameter" | "value"
	>("parameter");
	const [filterSelectedParameter, setFilterSelectedParameter] = createSignal(0);
	const [filterSelectedValue, setFilterSelectedValue] = createSignal(0);
	const [sortModal, setSortModal] = createSignal(false);
	const [sortSelectedIndex, setSortSelectedIndex] = createSignal(0);
	const [sortDirection, setSortDirection] = createSignal<"asc" | "desc">("asc");
	const filterParameters = ["Status", "Phase", "Agent"];
	const filterValues = createMemo(() =>
		filterParameters[filterSelectedParameter()] === "Status"
			? ["active", "paused", "attention-required", "completed", "closed"]
			: filterParameters[filterSelectedParameter()] === "Phase"
				? [
						...new Set(
							items().map((item) => item.state.stepId ?? item.state.phase),
						),
					].sort()
				: ["Active", "Inactive"],
	);
	const sortOptions = ["Name", "Created", "Updated", "Status"];
	createEffect(() => {
		filterSelectedParameter();
		const length = filterValues().length;
		setFilterSelectedValue((index) =>
			Math.min(Math.max(0, index), Math.max(0, length - 1)),
		);
	});
	const visibleItems = createMemo(() => {
		const parameter = filterParameters[filterSelectedParameter()];
		const value = filterValues()[filterSelectedValue()];
		const filtered = !value
			? items()
			: items().filter((item) =>
					parameter === "Agent"
						? value === "Active"
							? item.agents.some((agent) =>
									["pending", "working"].includes(agent.status),
								)
							: !item.agents.some((agent) =>
									["pending", "working"].includes(agent.status),
								)
						: parameter === "Status"
							? item.state.status === value
							: (item.state.stepId ?? item.state.phase) === value,
				);
		const option = sortOptions[sortSelectedIndex()];
		const direction = sortDirection() === "asc" ? 1 : -1;
		const valueFor = (item: WorkflowOverview) =>
			option === "Name"
				? item.state.changeId
				: option === "Created"
					? (item.state.createdAt ?? "")
					: option === "Updated"
						? (item.state.phaseStartedAt ?? "")
						: (item.state.status ?? "");
		return [...filtered].sort(
			(left, right) =>
				valueFor(left).localeCompare(valueFor(right)) * direction,
		);
	});
	createEffect(() => {
		const length = visibleItems().length;
		setSelected((index) =>
			Math.min(Math.max(0, index), Math.max(0, length - 1)),
		);
	});
	const diagnostic = (value?: string) =>
		value ? value.replace(/\s+/g, " ").slice(0, 96) : undefined;
	const workflowProgress = (item: WorkflowOverview) =>
		item.state.definition?.id === "research"
			? item.state.stepId === "core.wiki"
				? `wiki drafting: ${item.agents.find((agent) => agent.role === "wiki")?.status ?? "not started"}`
				: item.state.stepId === "core.wiki-approval"
					? "wiki approval"
					: `researcher: ${item.agents.find((agent) => agent.role === "researcher")?.status ?? "not started"}`
			: item.state.definition?.id === "wiki"
				? `documentation: ${item.agents.find((agent) => agent.role === "wiki")?.status ?? "not started"}`
				: `${item.tasks[0]}/${item.tasks[1]} tasks · planner: ${item.agents.find((agent) => agent.role === "planner")?.status ?? "not started"}`;
	const helpSections: HelpSection[] = [
		{
			title: "Navigation",
			items: [{ key: "j/k or ↑/↓", description: "Select workspace" }],
		},
		{
			title: "Actions",
			items: [
				{ key: "Enter", description: "Switch active workspace" },
				{ key: "n", description: "New workflow" },
				{ key: "m", description: "Agent configuration (profiles / presets)" },
				{ key: "f", description: "Open filter modal" },
				{ key: "o", description: "Open sort modal" },
				{ key: "r", description: "Refresh" },
				{ key: "q", description: "Quit" },
				{ key: "?", description: "Open help" },
			],
		},
	];
	const helpMaxOffset = () =>
		Math.max(
			0,
			helpSections.reduce(
				(count, section) => count + section.items.length + 1,
				0,
			) - Math.max(5, Math.floor(dimensions().height * 0.78) - 5),
		);
	const closeError = () => {
		setError(undefined);
		props.keymap.setData("modal.active", modal() ? "new-workflow" : "none");
	};
	const showError = (title: string, message: string) => {
		setError({ title, message });
		props.keymap.setData("modal.active", "error");
	};
	const showHerdrUnavailable = (
		message = "Herdr executable was not found. Install Herdr or add it to PATH.",
	) => showError("Herdr unavailable", message);
	const refresh = () => {
		props.refresh();
		setSelected((index) => Math.min(index, Math.max(0, items().length - 1)));
	};
	onMount(() => {
		// keymap layer registration + self-heal live here; the workspace list itself
		// is loaded/refreshed by the shell in the background.
	});
	const handleKey = (key: KeyEvent) => {
		const trace = (msg: string) => {
			const target = process.env.AGENTIC_CODING_TRACE;
			if (target) {
				try {
					require("node:fs").appendFileSync(
						target,
						`${Date.now()} home ${msg}\n`,
					);
				} catch {
					/* noop */
				}
			}
		};
		trace(
			`key=${key.name} modal.active=${props.keymap.getData?.("modal.active")}`,
		);
		const name = key.name.toLowerCase();
		// Lifecycle overlay (startup/shutdown modal) consumes keys; 'q' stays live
		// so startup can be cancelled (requestShutdown is idempotent).
		const lifecycleActive = phase() === "starting" || phase() === "stopping";
		if (lifecycleActive) {
			if (name === "q") globalThis.__requestShutdown?.();
			return;
		}
		if (modal()) return;
		if (name === "t" && key.shift) {
			setThemePicker(true);
			props.keymap.setData("modal.active", "theme");
		} else if (name === "?") {
			setHelp(true);
			setHelpOffset(0);
			props.keymap.setData("modal.active", "help");
		} else if (name === "q") globalThis.__requestShutdown?.();
		else if (name === "n") {
			setWorkflowPresets(listPresetNames());
			setModal(true);
			props.keymap.setData("modal.active", "new-workflow");
		} else if (name === "m") {
			setModelConfig(true);
			props.keymap.setData("modal.active", "model-config");
		} else if (name === "r") refresh();
		else if (name === "f") {
			setFilterModal(true);
			setFilterFocusedPane("parameter");
			setFilterSelectedParameter(0);
			setFilterSelectedValue(0);
			props.keymap.setData("modal.active", "filter");
		} else if (name === "o") {
			setSortModal(true);
			setSortSelectedIndex(0);
			props.keymap.setData("modal.active", "sort");
		} else if (name === "j" || name === "down")
			setSelected((index) =>
				Math.min(index + 1, Math.max(0, visibleItems().length - 1)),
			);
		else if (name === "k" || name === "up")
			setSelected((index) => Math.max(index - 1, 0));
		else if (name === "enter" || name === "return") {
			const item = visibleItems()[selected()];
			if (item?.state.health?.diagnostic) {
				showError("Invalid workflow state", item.state.health.diagnostic);
				return;
			}
			if (item?.workspaceOpen && item.state.status !== "closed") {
				try {
					focusWorkflow(item);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (!notifyHerdrError(message))
						showError(
							herdrAvailable()
								? "Workspace switch failed"
								: "Herdr unavailable",
							message,
						);
				}
			}
		}
	};
	onMount(() => {
		props.keymap.setData("app.view", "home");
		props.keymap.setData("modal.active", "none");
		const modalKeys = [
			"escape",
			"return",
			"enter",
			"meta+return",
			"meta+enter",
			"backspace",
			"delete",
			"up",
			"down",
			"left",
			"right",
			"home",
			"end",
			"j",
			"k",
			"d",
			"u",
			"/",
			..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=+[]{};:\\|,.<>`~!@#$%^&*() "
				.split("")
				.map((key) => (key === " " ? "space" : key)),
		];
		const disposeModal = props.keymap.registerLayer({
			name: "new-workflow",
			priority: 1000,
			activeModal: "new-workflow",
			commands: [
				{
					name: "new-workflow.handle",
					run: ({ event }) => modalHandler()?.(event) ?? true,
				},
			],
			bindings: modalKeys.map((key) => ({ key, cmd: "new-workflow.handle" })),
		});
		const disposeModelConfig = props.keymap.registerLayer({
			name: "model-config",
			priority: 1000,
			activeModal: "model-config",
			commands: [
				{
					name: "model-config.handle",
					run: ({ event }) => modelConfigHandler()?.(event) ?? true,
				},
			],
			bindings: modalKeys.map((key) => ({ key, cmd: "model-config.handle" })),
		});
		const disposeTheme = props.keymap.registerLayer({
			name: "theme-home",
			priority: 1100,
			activeModal: "theme",
			commands: [
				{
					name: "theme.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (key === "escape") {
							setThemePicker(false);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down") {
							const next = Math.min(themeNames.length - 1, themeIndex() + 1);
							setThemeIndex(next);
							applyTheme(themeNames[next]);
						} else if (key === "k" || key === "up") {
							const next = Math.max(0, themeIndex() - 1);
							setThemeIndex(next);
							applyTheme(themeNames[next]);
						} else if (key === "enter" || key === "return") {
							saveThemeName(themeNames[themeIndex()]);
							setThemePicker(false);
							props.keymap.setData("modal.active", "none");
						}
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
				(key) => ({ key, cmd: "theme.handle" }),
			),
		});
		const disposeHelp = props.keymap.registerLayer({
			name: "help",
			priority: 1100,
			activeModal: "help",
			commands: [
				{
					name: "help.close",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (key === "escape") {
							setHelp(false);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down")
							setHelpOffset((value) => Math.min(helpMaxOffset(), value + 1));
						else if (key === "k" || key === "up")
							setHelpOffset((value) => Math.max(0, value - 1));
						return true;
					},
				},
			],
			bindings: ["escape", "j", "k", "up", "down"].map((key) => ({
				key,
				cmd: "help.close",
			})),
		});
		const disposeError = props.keymap.registerLayer({
			name: "error",
			priority: 1100,
			activeModal: "error",
			commands: [
				{
					name: "error.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (key === "escape" || key === "enter" || key === "return") {
							closeError();
							return true;
						}
						if ((key === "j" || key === "down") && errorScroll) {
							errorScroll.scrollBy(1);
							return true;
						}
						if ((key === "k" || key === "up") && errorScroll) {
							errorScroll.scrollBy(-1);
							return true;
						}
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
				(key) => ({ key, cmd: "error.handle" }),
			),
		});
		const disposeFilter = props.keymap.registerLayer({
			name: "filter",
			priority: 1100,
			activeModal: "filter",
			commands: [
				{
					name: "filter.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (key === "escape") {
							setFilterModal(false);
							props.keymap.setData("modal.active", "none");
							return true;
						}
						if (key === "enter" || key === "return") {
							setSelected(0);
							notify("Filter applied", "info");
							setFilterModal(false);
							props.keymap.setData("modal.active", "none");
							return true;
						}
						if (key === "h" || key === "left") {
							setFilterFocusedPane("parameter");
							return true;
						}
						if (key === "l" || key === "right") {
							setFilterFocusedPane("value");
							return true;
						}
						if (key === "j" || key === "down") {
							if (filterFocusedPane() === "parameter") {
								setFilterSelectedParameter((i) =>
									Math.min(filterParameters.length - 1, i + 1),
								);
								setFilterSelectedValue(0);
							} else
								setFilterSelectedValue((i) =>
									Math.min(filterValues().length - 1, i + 1),
								);
							return true;
						}
						if (key === "k" || key === "up") {
							if (filterFocusedPane() === "parameter") {
								setFilterSelectedParameter((i) => Math.max(0, i - 1));
								setFilterSelectedValue(0);
							} else setFilterSelectedValue((i) => Math.max(0, i - 1));
							return true;
						}
						if (key === "space") {
							notify(`Toggled ${filterFocusedPane()} filter`, "info");
							return true;
						}
						return true;
					},
				},
			],
			bindings: [
				"escape",
				"enter",
				"return",
				"h",
				"l",
				"j",
				"k",
				"up",
				"down",
				"left",
				"right",
				"space",
			].map((key) => ({ key, cmd: "filter.handle" })),
		});
		const disposeSort = props.keymap.registerLayer({
			name: "sort",
			priority: 1100,
			activeModal: "sort",
			commands: [
				{
					name: "sort.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (key === "escape") {
							setSortModal(false);
							props.keymap.setData("modal.active", "none");
							return true;
						}
						if (key === "enter" || key === "return") {
							notify("Sort applied", "info");
							setSortModal(false);
							props.keymap.setData("modal.active", "none");
							return true;
						}
						if (key === "space") {
							setSortDirection((direction) =>
								direction === "asc" ? "desc" : "asc",
							);
							return true;
						}
						if (key === "j" || key === "down")
							setSortSelectedIndex((i) =>
								Math.min(sortOptions.length - 1, i + 1),
							);
						if (key === "k" || key === "up")
							setSortSelectedIndex((i) => Math.max(0, i - 1));
						return true;
					},
				},
			],
			bindings: [
				"escape",
				"enter",
				"return",
				"space",
				"j",
				"k",
				"up",
				"down",
			].map((key) => ({ key, cmd: "sort.handle" })),
		});
		const disposeHome = props.keymap.registerLayer({
			name: "home",
			priority: 100,
			appView: "home",
			activeModal: "none",
			commands: [
				{
					name: "home.handle",
					run: ({ event }) => {
						handleKey(event);
						return true;
					},
				},
			],
			bindings: [
				"q",
				"n",
				"m",
				"r",
				"f",
				"o",
				"?",
				"shift+t",
				"j",
				"k",
				"up",
				"down",
				"enter",
				"return",
			].map((key) => ({ key, cmd: "home.handle" })),
		});
		onCleanup(() => {
			disposeModal();
			disposeModelConfig();
			disposeTheme();
			disposeHelp();
			disposeError();
			disposeFilter();
			disposeSort();
			disposeHome();
		});
		// Self-heal: reconcile the keymap modal data with the real modal state, so a
		// modal closed by any path (mouse backdrop click, cancel, submit) never leaves
		// `modal.active` stuck — a stuck value deactivates the home layer and kills keys.
		createEffect(() => {
			const anyOpen =
				modal() ||
				filterModal() ||
				sortModal() ||
				help() ||
				themePicker() ||
				modelConfig() ||
				error() != null;
			if (!anyOpen) props.keymap.setData("modal.active", "none");
		});
	});
	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
			onMouseUp={() => invokeGlobalSelectionMouseUpHandler()}
		>
			<Panel title="Workspaces" active style={{ flexGrow: 1, minHeight: 0 }}>
				<Show
					when={loading()}
					fallback={
						<Show
							when={visibleItems().length > 0}
							fallback={
								<text fg={uiColors.textMuted}>
									{items().length
										? "No workflows match current filter"
										: "No workflows found in configured project roots"}
								</text>
							}
						>
							<SelectableList
								items={visibleItems()}
								selectedIndex={selected()}
								renderItem={(item, active) => (
									<box height={2} flexDirection="column" paddingLeft={1}>
										<text
											fg={
												active ? uiColors.textPrimary : uiColors.textSecondary
											}
										>
											{item.state.changeId}{" "}
											<span style={{ fg: uiColors.primary }}>
												{item.state.stepLabel ?? item.state.phase}
											</span>
											{diagnostic(item.state.health?.diagnostic) ? (
												<span style={{ fg: uiColors.error }}>
													{" "}
													· INVALID: {diagnostic(item.state.health?.diagnostic)}
												</span>
											) : null}
											{isStale(item.state, Date.now()) ? (
												<span style={{ fg: uiColors.warning }}> · STALE</span>
											) : null}
										</text>
										<text fg={uiColors.textMuted}>
											{item.state.definition?.label ?? "Workflow"} ·{" "}
											{workflowProgress(item)} ·{" "}
											{
												item.agents.filter(
													(agent) =>
														agent.status === "working" ||
														agent.status === "pending",
												).length
											}
											/{item.agents.length} agents active
										</text>
									</box>
								)}
							/>
						</Show>
					}
				>
					<text fg={uiColors.textMuted}>Loading workspaces…</text>
				</Show>
			</Panel>
			<NotificationOverlay />
			<Show when={themePicker()}>
				<ThemePickerModal
					selected={themeIndex()}
					active={getActiveThemeName()}
					themes={themeNames}
					query=""
					filtering={false}
				/>
			</Show>
			<Show when={modal()}>
				<NewWorkflowModal
					projects={projects()}
					presets={workflowPresets()}
					onKeyReady={(handler) => setModalHandler(() => handler)}
					onCancel={() => {
						setModal(false);
						props.keymap.setData("modal.active", "none");
						setModalHandler(undefined);
					}}
					onComplete={async (input) => {
						if (!herdrAvailable()) {
							showHerdrUnavailable();
							return;
						}
						setMessage("Starting workflow…");
						try {
							setMessage(
								await startWorkflow({
									...input,
									workflowType: input.workflowType ?? "openspec-full",
								}),
							);
							setModal(false);
							props.keymap.setData("modal.active", "none");
							setModalHandler(undefined);
							refresh();
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							showError(
								"Workflow execution failed",
								/permission denied \(publickey\)/i.test(message)
									? `${message}\nConfigure Git/SSH credential agent before starting workflow.`
									: message,
							);
						}
					}}
				/>
			</Show>
			<Show when={modelConfig()}>
				<ModelConfigModal
					onKeyReady={(handler) => setModelConfigHandler(() => handler)}
					onCancel={() => {
						setModelConfig(false);
						props.keymap.setData("modal.active", "none");
						setModelConfigHandler(undefined);
					}}
				/>
			</Show>
			<Show when={help()}>
				<HelpModal
					title="Workspace overview keybindings"
					sections={helpSections}
					offset={helpOffset()}
					lines={Math.max(5, Math.floor(dimensions().height * 0.78) - 5)}
				/>
			</Show>
			<Show when={filterModal()}>
				<FilterModal
					focusedPane={filterFocusedPane()}
					selectedParameter={filterSelectedParameter()}
					selectedValue={filterSelectedValue()}
					parameters={filterParameters}
					values={filterValues()}
				/>
			</Show>
			<Show when={sortModal()}>
				<SortModal
					selectedIndex={sortSelectedIndex()}
					options={sortOptions}
					direction={sortDirection()}
				/>
			</Show>
			<Show when={error()}>
				{(current) => (
					<ErrorDialog
						title={current().title}
						message={current().message}
						onClose={closeError}
						onScrollBoxReady={(ref) => {
							errorScroll = ref;
						}}
					/>
				)}
			</Show>
		</box>
	);
}
