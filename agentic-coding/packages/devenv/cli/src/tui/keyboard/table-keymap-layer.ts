import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { hostOwnedKeys } from "./host-keys.ts";
import { contextBindingNames } from "./registry.ts";
import { handleTableKeys, tableYieldsEscape } from "./table-keys.ts";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardStores,
} from "./types.ts";

export interface TableKeymapLayerDeps {
	stores: KeyboardStores;
	actions: KeyboardActions;
	ctx: KeyboardContext;
}

const TABLE_PRIORITY = 100;
const KUBERNETES_PRIORITY = 120;
/** Above the table handler: list-row workflow launch owns `w` where offered. */
const START_WORKFLOW_PRIORITY = TABLE_PRIORITY + 10;

/** Keys the table handler implements but that no view context declares, plus
 * the structural navigation every list needs. */
const STRUCTURAL_KEYS = [
	"up",
	"down",
	"left",
	"right",
	"space",
	"backspace",
	"delete",
	"ctrl+d",
	"ctrl+u",
	"ctrl+n",
	"tab",
] as const;

const TABLE_KEYS = [
	"tab",
	"shift+tab",
	"up",
	"down",
	"left",
	"right",
	"escape",
	"return",
	"enter",
	"backspace",
	"delete",
	"j",
	"k",
	"h",
	"l",
	"g",
	"G",
	"d",
	"u",
	"/",
	"F",
	"O",
	"space",
	"?",
	"r",
	"R",
	"s",
	"S",
	"x",
	"X",
	"b",
	"B",
	"m",
	"M",
	"p",
	"P",
	"L",
	"a",
	"e",
	"n",
	"w",
	"W",
	"i",
	"T",
	"1",
	"2",
	"3",
	"4",
	"5",
	"9",
	"ctrl+d",
	"ctrl+u",
	"ctrl+n",
	"ctrl+p",
	"ctrl+r",
	// Everything the registry declares for this context: the footer and `?` help
	// render those entries, so the keymap must bind them (the hand-written list
	// drifted — `+`, `-`, `A`, `H`, `c`, `f`, `t`, … were advertised and dead).
	...contextBindingNames("table").filter(
		// `Alt+C` copies the selection and belongs to the global layer, which is
		// registered above this one for every view.
		(key) => key !== "alt+c",
	),
	...STRUCTURAL_KEYS,
] as const;

const KUBERNETES_KEYS = [
	"r",
	"R",
	"s",
	"S",
	"x",
	"X",
	"l",
	"d",
	"p",
	"P",
	"b",
	"B",
	"m",
	"M",
	"o",
	"e",
	"9",
	"return",
	"enter",
] as const;
const KUBERNETES_PANEL_SCROLL_KEYS = ["j", "k", "up", "down"] as const;
const KUBERNETES_PANEL_HALF_PAGE_KEYS = ["d", "u", "ctrl+d", "ctrl+u"] as const;
const KUBERNETES_PANEL_EDGE_KEYS = ["g", "G"] as const;

const bind = (keys: readonly string[], command: string, category: string) =>
	keys.map((key) => ({
		key,
		cmd: command,
		context: "table",
		category,
		discoverable: false,
	}));

export function registerTableKeymapLayer(
	keymap: Keymap<Renderable, KeyEvent>,
	deps: TableKeymapLayerDeps,
): () => void {
	const runTable = (event: KeyEvent) => {
		const sequence =
			(event as KeyEvent & { sequence?: string }).sequence ??
			(event.shift && event.name.length === 1
				? event.name.toUpperCase()
				: event.name);
		return handleTableKeys(
			{ ...event, sequence },
			deps.stores,
			deps.actions,
			deps.ctx,
		);
	};

	// Escape must be able to *yield* to the shell at the feature's navigation
	// root, and an async command cannot report "not handled" back to the keymap
	// in time. The root case is therefore decided synchronously; everything the
	// feature does own (overlays, search, a deeper view mode) stays in the one
	// table handler.
	const runTableEscape = (event: KeyEvent): boolean => {
		if (tableYieldsEscape(deps.stores)) return false;
		void runTable(event);
		return true;
	};

	// Keys the host shell owns on every page, so its own bindings stay reachable
	// while this body is shown (see `hostOwnedKeys`).
	const shellOwnedKeys = hostOwnedKeys(deps.ctx.embedded);

	/**
	 * Contextual workflow launch from the list (`w`): the shell owns form and
	 * start boundary, so the selected row only reports its configured identity.
	 * One layer per category keeps the footer and `?` help honest — the key is
	 * advertised exactly where the row carries a startable application/library.
	 */
	const startWorkflowLayers = deps.ctx.startWorkflow
		? (["applications", "libraries"] as const).map((tab) => {
				const command = `table.${tab}.start-workflow`;
				return keymap.registerLayer({
					name: `Table: start workflow (${tab})`,
					priority: START_WORKFLOW_PRIORITY,
					...(deps.ctx.embedded ? { shellFeature: "environments" } : {}),
					shutdown: false,
					envModal: "none",
					appViewMode: "table",
					activeTab: tab,
					commands: [
						{
							name: command,
							context: "table",
							category: "Workflow",
							title: "Start workflow",
							desc: "Start a workflow for the selected application or library.",
							footer: "w",
							discoverable: true,
							run: ({ event }) => runTable(event),
						},
					],
					bindings: [
						{
							key: "w",
							cmd: command,
							context: "table",
							category: "Workflow",
							footer: "w",
							discoverable: true,
						},
					],
				});
			})
		: [];

	const disposers = [
		...startWorkflowLayers,
		keymap.registerLayer({
			name: "Table/List",
			priority: TABLE_PRIORITY,
			...(deps.ctx.embedded ? { shellFeature: "environments" } : {}),
			shutdown: false,
			envModal: "none",
			appViewMode: "table",
			commands: [
				{
					name: "table.handle",
					context: "table",
					category: "Table",
					title: "Table navigation/actions",
					desc: "Handle table and list navigation, selection, search, filter, sort, and row actions.",
					discoverable: false,
					run: ({ event }) => runTable(event),
				},
				{
					name: "table.escape",
					context: "table",
					category: "Table",
					title: "Escape/back",
					desc: "Clear search, close an overlay or leave one view level; at the root it yields to the shell.",
					discoverable: false,
					run: ({ event }) => runTableEscape(event),
				},
				{
					name: "table.tab.previous",
					context: "table",
					category: "Navigation",
					title: "Previous tab",
					desc: "Reverse tab cycle",
					footer: "Shift+Tab",
					discoverable: true,
					run: ({ event }) => runTable(event),
				},
				{
					name: "table.search.open",
					context: "table",
					category: "List controls",
					title: "Search",
					desc: "Open table/list search where supported.",
					footer: "/",
					discoverable: true,
					run: ({ event }) => runTable(event),
				},
				{
					name: "table.filter.open",
					context: "table",
					category: "List controls",
					title: "Filter",
					desc: "Open table/list filter where supported.",
					footer: "F",
					discoverable: true,
					run: ({ event }) => runTable(event),
				},
				{
					name: "table.sort.open",
					context: "table",
					category: "List controls",
					title: "Order/sort",
					desc: "Open table/list sort where supported.",
					footer: "O",
					discoverable: true,
					run: ({ event }) => runTable(event),
				},
				{
					name: "actions.toggle",
					context: "table",
					category: "Actions",
					title: "Action history",
					desc: "Toggle action history without starting an action.",
					footer: "L",
					discoverable: true,
					run: () => {
						deps.stores.appStore.pushModal("actions");
						return true;
					},
				},
			],
			bindings: [
				...bind(
					TABLE_KEYS.filter(
						(key) =>
							key !== "/" &&
							key !== "F" &&
							key !== "O" &&
							key !== "L" &&
							key !== "shift+tab" &&
							key !== "escape" &&
							!shellOwnedKeys.has(key),
					),
					"table.handle",
					"Table",
				),
				{
					key: "escape",
					cmd: "table.escape",
					context: "table",
					category: "Table",
					discoverable: false,
				},
				{
					key: "shift+tab",
					cmd: "table.tab.previous",
					context: "table",
					category: "Navigation",
					footer: "Shift+Tab",
					discoverable: true,
				},
				{
					key: "/",
					cmd: "table.search.open",
					context: "table",
					category: "List controls",
					footer: "/",
					discoverable: true,
				},
				{
					key: "F",
					cmd: "table.filter.open",
					context: "table",
					category: "List controls",
					footer: "F",
					discoverable: true,
				},
				{
					key: "O",
					cmd: "table.sort.open",
					context: "table",
					category: "List controls",
					footer: "O",
					discoverable: true,
				},
			],
		}),
		...Array.from({ length: 4 }, (_, index) => {
			const scrollCommand = `kubernetes.panel.${index}.scroll`;
			const halfPageCommand = `kubernetes.panel.${index}.half-page`;
			const edgeCommand = `kubernetes.panel.${index}.edge`;
			return keymap.registerLayer({
				name: `Kubernetes Panel ${index + 1}`,
				priority: KUBERNETES_PRIORITY + 20,
				...(deps.ctx.embedded ? { shellFeature: "environments" } : {}),
				shutdown: false,
				envModal: "none",
				appViewMode: "table",
				activeTab: "kubernetes",
				focusedPanel: `kubernetes:${index}`,
				commands: [
					{
						name: scrollCommand,
						context: "kubernetes",
						category: "Panel",
						title: "Scroll focused Kubernetes panel",
						desc: "Scroll the focused Kubernetes panel.",
						footer: "j/k",
						discoverable: true,
						run: ({ event }) => runTable(event),
					},
					{
						name: halfPageCommand,
						context: "kubernetes",
						category: "Panel",
						title: "Half page",
						desc: "Scroll focused Kubernetes panel by half a page.",
						footer: "d/u",
						discoverable: true,
						run: ({ event }) => runTable(event),
					},
					{
						name: edgeCommand,
						context: "kubernetes",
						category: "Panel",
						title: "Top/bottom",
						desc: "Scroll focused Kubernetes panel to top or bottom.",
						footer: "g/G",
						discoverable: true,
						run: ({ event }) => runTable(event),
					},
				],
				bindings: [
					...bind(KUBERNETES_PANEL_SCROLL_KEYS, scrollCommand, "Panel"),
					...bind(KUBERNETES_PANEL_HALF_PAGE_KEYS, halfPageCommand, "Panel"),
					...bind(KUBERNETES_PANEL_EDGE_KEYS, edgeCommand, "Panel"),
				],
			});
		}),
		keymap.registerLayer({
			name: "Kubernetes Tab",
			priority: KUBERNETES_PRIORITY,
			...(deps.ctx.embedded ? { shellFeature: "environments" } : {}),
			shutdown: false,
			envModal: "none",
			appViewMode: "table",
			activeTab: "kubernetes",
			commands: [
				{
					name: "kubernetes.handle",
					context: "kubernetes",
					category: "Kubernetes",
					title: "Kubernetes action",
					desc: "Handle Kubernetes tab lifecycle actions.",
					discoverable: false,
					run: ({ event }) => runTable(event),
				},
				{
					name: "kubernetes.panel.next",
					context: "kubernetes",
					category: "Navigation",
					title: "Next panel",
					desc: "Cycle panel focus in Kubernetes cluster view",
					footer: "J",
					discoverable: true,
					run: ({ event }) => runTable(event),
				},
				{
					name: "kubernetes.panel.previous",
					context: "kubernetes",
					category: "Navigation",
					title: "Previous panel",
					desc: "Cycle panel focus in Kubernetes cluster view",
					footer: "K",
					discoverable: true,
					run: ({ event }) => runTable(event),
				},
			],
			bindings: [
				...bind(KUBERNETES_KEYS, "kubernetes.handle", "Kubernetes"),
				{
					key: "J",
					cmd: "kubernetes.panel.next",
					context: "kubernetes",
					category: "Navigation",
					footer: "J",
					discoverable: true,
				},
				{
					key: "K",
					cmd: "kubernetes.panel.previous",
					context: "kubernetes",
					category: "Navigation",
					footer: "K",
					discoverable: true,
				},
			],
		}),
	];

	return () => {
		for (const dispose of [...disposers].reverse()) dispose();
	};
}
