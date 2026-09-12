import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { handleTableKeys } from "./table-keys";
import type { KeyboardActions, KeyboardContext, KeyboardStores } from "./types";

export interface TableKeymapLayerDeps {
	stores: KeyboardStores;
	actions: KeyboardActions;
	ctx: KeyboardContext;
}

const TABLE_PRIORITY = 100;
const KUBERNETES_PRIORITY = 120;

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

	const disposers = [
		keymap.registerLayer({
			name: "Table/List",
			priority: TABLE_PRIORITY,
			shutdown: false,
			activeModal: "none",
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
							key !== "shift+tab",
					),
					"table.handle",
					"Table",
				),
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
				shutdown: false,
				activeModal: "none",
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
			shutdown: false,
			activeModal: "none",
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
