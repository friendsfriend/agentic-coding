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
import { bindings, type Keybind } from "../../ui/keybinds.ts";
export const nativeAgentNavigationKeybinds: Keybind[] = [
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
		standard: true,
	},
];
/** Native catalog binding for the original agent sidebar. Unknown observation
 * stays unknown; writability is never interpreted as live generation. */
export function NativeAgentNavigation(props: {
	sessions: Session[];
	tasks: Data[];
	active: boolean;
	connected: boolean;
	widthLimit: number;
	onWidth?: (width: number) => void;
	selected: string | null;
	focus: () => void;
	open: (id: number) => void;
}) {
	const [permanent, setPermanent] = createSignal(false);
	const [selected, setSelected] = createSignal<string>();
	const sessions = createMemo(() =>
		props.sessions.filter((session) => session.parent !== null),
	);
	const rows = createMemo<AgentSidebarRow[]>(() =>
		sessions().map((session) => {
			const task = props.tasks.find((value) => value.id === session.task);
			const result =
				task?.result &&
				typeof task.result === "object" &&
				!Array.isArray(task.result)
					? (task.result as Data)
					: null;
			const status =
				result?.status === "completed" || result?.status === "success"
					? "completed"
					: result?.status === "failed"
						? "failed"
						: result?.status === "cancelled"
							? "expired"
							: task?.detail === "awaiting review"
								? "blocked"
								: task?.activity && task.activity !== "idle"
									? "working"
									: "unknown";
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
		if (sessions().some((session) => String(session.id) === key))
			props.open(Number(key));
	};
	const open = () => {
		const key = selected();
		if (key !== undefined) openKey(key);
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.native-agent-navigation",
		priority: 15,
		enabled: () => props.active,
		commands: [
			{
				id: "agents.previous",
				name: "Previous native agent",
				run: () => move(-1),
			},
			{ id: "agents.next", name: "Next native agent", run: () => move(1) },
			{ id: "agents.open", name: "Open native agent transcript", run: open },
		],
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
			onToggleMode={() => setPermanent(!permanent())}
			onSelectIndex={(value) => {
				const row = rows()[value];
				if (row) setSelected(row.key);
			}}
			onOpen={(row) => openKey(row.key)}
			onFocus={props.focus}
		/>
	);
}
