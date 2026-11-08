/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { Selectable } from "../../presentation/components/Selectable.tsx";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const commandToken = (value: unknown) =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 128 &&
	!/\s/.test(value);
/** Native resource overview. No engine probing, lease adoption or action execution. */
export function ResourcePanel(props: {
	kind: "schedules" | "environments";
	rows: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	environments: Data | undefined;
	connected: boolean;
	expanded: string[];
	toggle: (key: string) => void;
	prepare: (command: string) => void;
	openTask: (id: number) => void;
}) {
	const details = (key: string, label: string, value: unknown) => (
		<>
			<ActionHeader onActivate={() => props.toggle(key)}>
				<text fg={color("accent")}>
					{props.expanded.includes(key) ? "▾" : "▸"} {label}
				</text>
			</ActionHeader>
			<Show when={props.expanded.includes(key)}>
				<text wrapMode="word">{JSON.stringify(value, null, 2)}</text>
			</Show>
		</>
	);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				{props.kind === "schedules"
					? "Native schedules"
					: "Configured native environments"}{" "}
				· {props.rows.length} matching
			</text>
			<text fg={color("textMuted")}>
				{props.connected
					? "Last observed inventory; not live readiness or execution authority"
					: "Cached inventory; current activity unknown"}
			</text>
			<Show when={props.kind === "schedules"}>
				<text fg={color("textMuted")}>
					Create/update stays with the orchestrator. Deletion retires future
					timing, not an already admitted task.
				</text>
			</Show>
			<For each={props.rows}>
				{(row, index) => (
					<Selectable
						selected={props.selected(row, index())}
						onMouseUp={() => props.select(row, index())}
					>
						<box flexDirection="column" gap={1}>
							<ActionHeader onActivate={() => props.select(row, index())}>
								<text fg={color("primary")}>
									{props.selected(row, index()) ? "▾" : "▸"} {String(row.id)} ·{" "}
									{String(row.state ?? row.kind)}
								</text>
							</ActionHeader>
							<Show when={props.selected(row, index())}>
								<Show when={props.kind === "schedules"}>
									<text wrapMode="word">
										Revision {String(row.revision)} · next due{" "}
										{row.nextDue === null
											? "none recorded"
											: String(row.nextDue)}{" "}
										(epoch ms) · late grace{" "}
										{String(row.lateGraceMs ?? "run late")}
									</text>
									<text wrapMode="word">
										Skill {String(object(row.invocation).skill)} · topic{" "}
										{String(object(row.invocation).topicId)} · profile{" "}
										{String(object(row.invocation).profile)}
									</text>
									<Show when={typeof row.activeTask === "number"}>
										<ActionHeader
											onActivate={() => props.openTask(Number(row.activeTask))}
										>
											<text fg={color("accent")}>
												Open admitted task #{String(row.activeTask)}
											</text>
										</ActionHeader>
									</Show>
									<Show when={row.lastError}>
										<text fg={color("warning")} wrapMode="word">
											Last recorded error: {String(row.lastError)}
										</text>
									</Show>
									{details(
										`schedule:${String(row.id)}:timing`,
										"Exact timing and invocation",
										{ timing: row.timing, invocation: row.invocation },
									)}
									{details(
										`schedule:${String(row.id)}:history`,
										"Retained occurrence history",
										row.history,
									)}
									<Show
										when={
											props.connected &&
											commandToken(row.id) &&
											Number.isSafeInteger(row.revision) &&
											Number(row.revision) >= 1
										}
									>
										<ActionHeader
											onActivate={() =>
												props.prepare(
													`/delete-schedule ${String(row.id)}@${String(row.revision)}`,
												)
											}
										>
											<text fg={color("warning")}>
												Prepare revision-fenced deletion (does not submit)
											</text>
										</ActionHeader>
									</Show>
								</Show>
								<Show when={props.kind === "environments"}>
									<text wrapMode="word">
										Repository: {String(row.repository)} · prerequisites:{" "}
										{JSON.stringify(row.requires ?? [])}
									</text>
									<For each={dataList(row.targets)}>
										{(target) => (
											<box flexDirection="column" paddingLeft={1} gap={1}>
												<text fg={color("primary")}>
													{String(target.id)} · {String(target.action)} ·{" "}
													{String(target.runtime)} ·{" "}
													{String(target.profile ?? "default profile")}
												</text>
												{details(
													`environment:${String(row.id)}:target:${String(target.id)}`,
													"Native target definition and availability",
													target,
												)}
												<Show
													when={
														props.connected &&
														commandToken(row.id) &&
														commandToken(target.id) &&
														row.kind !== "infrastructure" &&
														["run", "build", "test"].includes(
															String(target.action),
														)
													}
												>
													<ActionHeader
														onActivate={() =>
															props.prepare(
																`/${String(target.action)} ${String(row.id)} ${String(target.id)}`,
															)
														}
													>
														<text fg={color("accent")}>
															Prepare {String(target.action)} task (native exact
															approval still required)
														</text>
													</ActionHeader>
												</Show>
											</box>
										)}
									</For>
									<For
										each={dataList(props.environments?.runs).filter(
											(run) => object(run.plan).app === row.id,
										)}
									>
										{(run) => (
											<box
												flexDirection="column"
												border={["top"]}
												borderColor={color("border")}
												gap={1}
											>
												<text wrapMode="word">
													Run {String(run.id)} · {String(run.state)} · owner #
													{String(run.owner)} · recorded readiness{" "}
													{String(run.ready ?? "unknown")} · revision{" "}
													{String(run.revision)}
												</text>
												<Show when={run.error}>
													<text fg={color("warning")} wrapMode="word">
														{String(run.error)}
													</text>
												</Show>
												<ActionHeader
													onActivate={() => props.openTask(Number(run.owner))}
												>
													<text fg={color("accent")}>
														Inspect native owner task
													</text>
												</ActionHeader>
												{details(
													`environment:run:${String(run.id)}`,
													"Retained run / idle / cleanup diagnostics (not lease authority)",
													run,
												)}
											</box>
										)}
									</For>
									{details(
										`environment:${String(row.id)}:waiters`,
										"Current observed acquisition waiters",
										dataList(props.environments?.waiters).filter(
											(waiter) =>
												Array.isArray(waiter.apps) &&
												waiter.apps.includes(row.id),
										),
									)}
									<Show when={props.connected && commandToken(row.id)}>
										<ActionHeader
											onActivate={() =>
												props.prepare(`/logs ${String(row.id)}`)
											}
										>
											<text fg={color("accent")}>
												Prepare diagnostic logs read (does not stop or take over
												an app)
											</text>
										</ActionHeader>
									</Show>
								</Show>
							</Show>
						</box>
					</Selectable>
				)}
			</For>
		</box>
	);
}
