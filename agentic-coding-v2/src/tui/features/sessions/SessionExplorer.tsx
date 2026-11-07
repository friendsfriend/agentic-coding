/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { Data, Session } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";
/** Native catalog only: parent pointers describe observation, never arbitrary adoption. */
export function SessionExplorer(props: {
	sessions: Session[];
	tasks: Data[];
	selected: string | null;
	select: (id: string) => void;
	open: (id: number) => void;
	prepare: (command: string) => void;
	connected: boolean;
}) {
	const depth = (session: Session) => {
		let parent = session.parent,
			depth = 0;
		const seen = new Set([session.id]);
		while (parent !== null && depth < 6 && !seen.has(parent)) {
			seen.add(parent);
			depth++;
			parent =
				props.sessions.find((item) => item.id === parent)?.parent ?? null;
		}
		return depth;
	};
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Pi Durable · authorized native conversation catalog
			</text>
			<text fg={color("textMuted")}>
				Current bounded/non-atomic session inventory. Native tasks have a
				separate current owned worker tree in task detail. Hidden, missing or
				terminal internal conversations are not silently reconstructed/adopted.
			</text>
			<Show when={!props.connected}>
				<text fg={color("warning")}>
					Disconnected; this catalog is cached, not evidence of current
					writability.
				</text>
			</Show>
			<For each={props.sessions}>
				{(session) => (
					<box
						flexDirection="column"
						paddingLeft={depth(session) * 2}
						border={String(session.id) === props.selected}
						paddingTop={0}
						paddingBottom={0}
					>
						<ActionHeader onActivate={() => props.select(String(session.id))}>
							<text fg={color("accent")}>
								{String(session.id) === props.selected ? "›" : "·"} #
								{session.id} · {session.title} ·{" "}
								{session.writable && props.connected
									? "observed writable"
									: "read-only/unknown"}
							</text>
						</ActionHeader>
						<text wrapMode="word" fg={color("textMuted")}>
							Parent{" "}
							{session.parent === null
								? "native orchestrator root"
								: `#${session.parent}`}{" "}
							· owning app task{" "}
							{session.task === null ? "none" : `#${session.task}`}
							{session.task === null
								? ""
								: ` · ${String(props.tasks.find((task) => task.id === session.task)?.detail ?? "task status unavailable")}`}
						</text>
						<Show when={String(session.id) === props.selected}>
							<ActionHeader onActivate={() => props.open(session.id)}>
								<text fg={color("accent")}>
									Open exact retained/live transcript (unsent per-session draft
									is preserved)
								</text>
							</ActionHeader>
							<ActionHeader
								onActivate={() => props.prepare(`/inspect-model ${session.id}`)}
							>
								<text fg={color("accent")}>
									Prepare native model/thinking inspection
								</text>
							</ActionHeader>
							<Show when={session.task !== null}>
								<ActionHeader
									onActivate={() => props.prepare(`/task ${session.task}`)}
								>
									<text fg={color("accent")}>
										Prepare owning app-task detail
									</text>
								</ActionHeader>
							</Show>
						</Show>
					</box>
				)}
			</For>
			<Show when={!props.sessions.length}>
				<text fg={color("textMuted")}>
					No authorized sessions match this inventory/filter. No arbitrary
					identity is adopted.
				</text>
			</Show>
		</box>
	);
}
