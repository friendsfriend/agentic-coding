/** @jsxImportSource @opentui/solid */
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import type { Data, Session } from "../../../protocol/index.ts";
import type { AgentSidebarRow } from "../../presentation/agent-sidebar-model.ts";
import { AgentSidebar } from "../../presentation/components/AgentSidebar.tsx";
import { bindings, type Keybind, layerCommands } from "../../ui/keybinds.ts";
export const nativeAgentNavigationKeybinds: Keybind[] = [
	{
		key: "f",
		cmd: "agents.filter",
		action: "Switch Active/All agent filter",
		short: "filter",
	},
	{
		key: "e",
		cmd: "agents.size",
		action: "Toggle expanding/permanent sidebar",
		short: "size",
	},
	{
		key: "up",
		cmd: "agents.previous",
		action: "Previous native agent",
		standard: true,
	},
	{
		key: "down",
		cmd: "agents.next",
		action: "Next native agent",
		standard: true,
	},
	{
		key: "k",
		cmd: "agents.previous",
		action: "Previous native agent",
		standard: true,
	},
	{ key: "j", cmd: "agents.next", action: "Next native agent", standard: true },
	{
		key: "enter",
		cmd: "agents.open",
		action: "Open native agent transcript",
		short: "open",
	},
];
/** Native catalog binding for the original agent sidebar. Unknown observation
 * stays unknown; writability is never interpreted as live generation. */
export function NativeAgentNavigation(props: {
	sessions: Session[];
	tasks: Data[];
	active: boolean;
	/** Unfocused sidebars accept focus taps; covered sidebars must not. */
	interactive?: boolean;
	connected: boolean;
	widthLimit: number;
	onWidth?: (width: number) => void;
	selected: string | null;
	focus: () => void;
	open: (id: number) => void;
}) {
	const [permanent, setPermanent] = createSignal(false);
	const [filter, setFilter] = createSignal<"active" | "all">("active");
	const interactive = () => props.interactive !== false;
	const toggleSize = () => {
		if (interactive()) setPermanent((value) => !value);
	};
	const [selected, setSelected] = createSignal<string>();
	const sessions = createMemo(() =>
		props.sessions.filter((session) => session.parent !== null),
	);
	const sourceRows = createMemo<AgentSidebarRow[]>(() =>
		sessions().map((session) => {
			const task = props.tasks.find((value) => value.id === session.task);
			const result =
				task?.result &&
				typeof task.result === "object" &&
				!Array.isArray(task.result)
					? (task.result as Data)
					: null;
			let status = "unknown";
			if (result?.status === "completed" || result?.status === "success")
				status = "completed";
			else if (result?.status === "failed") status = "failed";
			else if (result?.status === "cancelled") status = "expired";
			else if (props.connected) {
				if (task?.detail === "awaiting review") status = "blocked";
				else if (task?.activity === "running") status = "working";
				else if (task?.activity === "idle" && task.detail === "queued")
					status = "pending";
			}
			return {
				key: String(session.id),
				role: session.title,
				workflowId:
					session.task === null
						? `Conversation #${session.id}`
						: `Task #${session.task}`,
				workflowStep:
					typeof task?.detail === "string" ? task.detail : undefined,
				status,
			};
		}),
	);
	// The original active filter is run-status-only. Unknown/blocked/terminal
	// observations remain available under All, never inferred to be active.
	const rows = createMemo(() =>
		filter() === "all"
			? sourceRows()
			: sourceRows().filter(
					(row) => row.status === "pending" || row.status === "working",
				),
	);
	createEffect(
		on(
			() => props.selected,
			(key) => setSelected(key ?? undefined),
		),
	);
	createEffect(() => {
		// Establish the original first-row cursor only when no preference exists.
		// Polling must neither overwrite a keyboard choice nor replace a removed key.
		const first = rows()[0];
		if (selected() === undefined && first) setSelected(first.key);
	});
	const index = () => rows().findIndex((row) => row.key === selected());
	const move = (direction: number) => {
		if (!props.active || !interactive()) return;
		const current = index();
		const next =
			current < 0
				? direction < 0
					? rows().length - 1
					: 0
				: Math.max(0, Math.min(rows().length - 1, current + direction));
		const row = rows()[next];
		if (row) setSelected(row.key);
	};
	const openKey = (key: string) => {
		if (
			interactive() &&
			rows().some((row) => row.key === key) &&
			sessions().some((session) => String(session.id) === key)
		)
			props.open(Number(key));
	};
	const open = () => {
		if (!props.active || !interactive()) return;
		const key = selected();
		if (key !== undefined) openKey(key);
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.native-agent-navigation",
		priority: 15,
		enabled: () => props.active && interactive(),
		commands: layerCommands([
			{
				id: "agents.filter",
				name: "Switch Active/All filter",
				run: () => {
					if (props.active && interactive())
						setFilter((value) => (value === "active" ? "all" : "active"));
				},
			},
			{
				id: "agents.size",
				name: "Toggle sidebar size",
				run: () => {
					if (props.active) toggleSize();
				},
			},
			{
				id: "agents.previous",
				name: "Previous native agent",
				run: () => move(-1),
			},
			{ id: "agents.next", name: "Next native agent", run: () => move(1) },
			{ id: "agents.open", name: "Open native agent transcript", run: open },
		]),
		bindings: bindings(nativeAgentNavigationKeybinds),
	});
	onCleanup(unregister);
	return (
		<AgentSidebar
			active={props.active}
			mode={permanent() ? "permanent" : "expanding"}
			widthLimit={props.widthLimit}
			onWidth={props.onWidth}
			rows={rows()}
			selectedIndex={index()}
			sourceState={props.connected ? "fresh" : "stale"}
			onToggleMode={toggleSize}
			onSelectIndex={(value) => {
				if (!interactive()) return;
				const row = rows()[value];
				if (row) setSelected(row.key);
			}}
			onOpen={(row) => openKey(row.key)}
			onFocus={() => {
				if (interactive()) props.focus();
			}}
		/>
	);
}
