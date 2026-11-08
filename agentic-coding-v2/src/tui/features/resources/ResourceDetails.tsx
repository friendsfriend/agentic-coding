/** @jsxImportSource @opentui/solid */
import { createHash } from "node:crypto";
import { createMemo, For, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const taskId = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) > 0;
export const resourceCommandToken = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 128 &&
	!/\s/.test(value) &&
	Array.from(value).every(
		(character) =>
			character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
	);
/** Selected supplied resource fields only. Local disclosures/ordinals never
 * become native identity, current readiness, leases or confirmation authority. */
export function ResourceDetails(props: {
	row: Data;
	kind: "schedules" | "environments";
	scope: object;
	environments: Data | undefined;
	interactive: boolean;
	connected: boolean;
	fresh: boolean;
	member: () => boolean;
	expanded: string[];
	toggle: (key: string) => void;
	prepare: (command: string) => boolean;
	openTask: (id: number) => void;
	chooseTarget: (action: string) => void;
}) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const source = createMemo(() => ({
		row: props.row,
		scope: props.scope,
		environments: props.environments,
	}));
	const controls = createMemo(() => [
		source(),
		props.interactive,
		props.fresh,
		props.connected,
	]);
	const available = () => !disposed && props.member();
	const active = () => available() && props.interactive;
	// Complete supplied response fingerprint + ordinal: UI fold keys only.
	const fingerprint = createMemo(() =>
		createHash("sha256").update(JSON.stringify(props.row)).digest("hex"),
	);
	const key = (name: string, value: unknown) =>
		`resource-detail:${fingerprint()}:${createHash("sha256")
			.update(JSON.stringify(value) ?? "not supplied")
			.digest("hex")}:${name}`;
	const disclosure = (name: string, label: string, value: unknown) => (
		<box flexDirection="column" gap={1}>
			<ActionHeader
				scope={controls()}
				interactive={active()}
				onActivate={() => {
					if (active()) props.toggle(key(name, value));
				}}
			>
				<text fg={color("accent")}>
					{props.expanded.includes(key(name, value)) ? "▾" : "▸"} {label}
				</text>
			</ActionHeader>
			<Show when={props.expanded.includes(key(name, value))}>
				<SuppliedObservation value={value} label={label} scope={source()} />
			</Show>
		</box>
	);
	const targets = createMemo(() => dataList(props.row.targets));
	const history = createMemo(() => dataList(props.row.history));
	const runs = createMemo(() =>
		dataList(props.environments?.runs).filter(
			(run) => object(run.plan).app === props.row.id,
		),
	);
	const waiters = createMemo(() =>
		dataList(props.environments?.waiters).filter(
			(waiter) =>
				Array.isArray(waiter.apps) && waiter.apps.includes(props.row.id),
		),
	);
	const targetMember = (target: Data) =>
		available() &&
		typeof target.id === "string" &&
		target.id.length > 0 &&
		targets().filter((row) => row.id === target.id).length === 1 &&
		targets().some((row) => row === target);
	const runMember = (run: Data) =>
		available() &&
		typeof run.id === "string" &&
		run.id.length > 0 &&
		runs().filter((row) => row.id === run.id).length === 1 &&
		runs().some((row) => row === run);
	const occurrenceMember = (entry: Data) =>
		available() &&
		history().some((row) => row === entry) &&
		history().filter((row) => row.due === entry.due && row.task === entry.task)
			.length === 1;
	const prepare = (command: string) =>
		active() && props.fresh && props.connected && props.prepare(command);
	return (
		<box flexDirection="column" gap={1} paddingLeft={1}>
			<Show when={props.kind === "schedules"}>
				<text wrapMode="word">
					Revision {String(props.row.revision ?? "not supplied")} · next due{" "}
					{props.row.nextDue === null
						? "none recorded"
						: String(props.row.nextDue ?? "not supplied")}{" "}
					(epoch ms) · late grace {String(props.row.lateGraceMs ?? "run late")}
				</text>
				<text wrapMode="word">
					Skill {String(object(props.row.invocation).skill ?? "not supplied")} ·
					topic {String(object(props.row.invocation).topicId ?? "not supplied")}{" "}
					· profile{" "}
					{String(object(props.row.invocation).profile ?? "not supplied")}
				</text>
				<Show when={taskId(props.row.activeTask)}>
					<ActionHeader
						scope={controls()}
						interactive={active()}
						onActivate={() => {
							if (active() && taskId(props.row.activeTask))
								props.openTask(props.row.activeTask);
						}}
					>
						<text fg={color("accent")}>
							Open supplied active task #{String(props.row.activeTask)}
						</text>
					</ActionHeader>
				</Show>
				<Show
					when={
						props.row.lastError !== undefined && props.row.lastError !== null
					}
				>
					{disclosure(
						"error",
						"Last recorded error (not current outcome)",
						props.row.lastError,
					)}
				</Show>
				{disclosure("timing", "Supplied timing and invocation fields", {
					timing: props.row.timing,
					invocation: props.row.invocation,
				})}
				<text fg={color("textMuted")}>
					Retained occurrences: {history().length}. Display order is supplied;
					missing/clipped history never proves no activity.
				</text>
				<SuppliedRecordWindow
					rows={history()}
					scope={source()}
					label="schedule occurrences"
					title={(entry) =>
						`due ${String(entry.due ?? "not supplied")} · task ${String(entry.task ?? "not supplied")} · ${String(entry.result ?? "outcome not supplied")}`
					}
					search={(entry) => JSON.stringify(entry)}
				>
					{(entry, index) => (
						<box
							flexDirection="column"
							gap={1}
							border={["left"]}
							borderColor={color("border")}
							paddingLeft={1}
						>
							<text wrapMode="word">
								{index() + 1}. Due {String(entry.due ?? "not supplied")} (epoch
								ms) · recorded outcome {String(entry.result ?? "not supplied")}
							</text>
							<Show when={taskId(entry.task)}>
								<ActionHeader
									scope={controls()}
									interactive={active() && occurrenceMember(entry)}
									onActivate={() => {
										if (
											active() &&
											occurrenceMember(entry) &&
											taskId(entry.task)
										)
											props.openTask(entry.task);
									}}
								>
									<text fg={color("accent")}>
										Open supplied occurrence task #{String(entry.task)}
									</text>
								</ActionHeader>
							</Show>
							{disclosure(
								`occurrence:${index()}`,
								"Supplied occurrence record",
								entry,
							)}
						</box>
					)}
				</SuppliedRecordWindow>
				{disclosure(
					"history",
					"Serialized retained occurrence history",
					props.row.history,
				)}
				<Show
					when={
						resourceCommandToken(props.row.id) && taskId(props.row.revision)
					}
				>
					<ActionHeader
						scope={controls()}
						interactive={active() && props.fresh && props.connected}
						onActivate={() => {
							if (
								resourceCommandToken(props.row.id) &&
								taskId(props.row.revision)
							)
								prepare(
									`/delete-schedule ${props.row.id}@${props.row.revision}`,
								);
						}}
					>
						<text fg={color("warning")}>
							Prepare revision-fenced deletion (does not submit or cancel
							admitted tasks)
						</text>
					</ActionHeader>
				</Show>
			</Show>
			<Show when={props.kind === "environments"}>
				<text wrapMode="word">
					Repository {String(props.row.repository ?? "not supplied")} · targets{" "}
					{targets().length} · matching supplied runs {runs().length}
				</text>
				{disclosure(
					"requires",
					"Supplied prerequisites (not readiness)",
					props.row.requires,
				)}
				<For
					each={["run", "build", "test"].filter((action) =>
						targets().some((target) => target.action === action),
					)}
				>
					{(action) => (
						<ActionHeader
							scope={controls()}
							interactive={active() && props.fresh && props.connected}
							onActivate={() => {
								if (active()) props.chooseTarget(action);
							}}
						>
							<text fg={color("accent")}>
								Choose supplied {action} target/profile bundle (prepare only)
							</text>
						</ActionHeader>
					)}
				</For>
				<SuppliedRecordWindow
					rows={targets()}
					scope={source()}
					label="target definitions"
					title={(target) =>
						`${String(target.id ?? "not supplied")} · ${String(target.action ?? "not supplied")} · ${String(target.runtime ?? "not supplied")}`
					}
					search={(target) => JSON.stringify(target)}
				>
					{(target, index) => (
						<box flexDirection="column" gap={1}>
							<text fg={color("primary")}>
								{index() + 1}. {String(target.id ?? "identity not supplied")} ·{" "}
								{String(target.action ?? "not supplied")} ·{" "}
								{String(target.runtime ?? "not supplied")} · profile{" "}
								{String(target.profile ?? "not supplied")}
							</text>
							<Show when={!targetMember(target)}>
								<text fg={color("warning")}>
									Ambiguous target identity; command preparation disabled.
								</text>
							</Show>
							{disclosure(
								`target:${index()}`,
								"Supplied target definition / availability",
								target,
							)}
							<Show
								when={
									targetMember(target) &&
									resourceCommandToken(props.row.id) &&
									resourceCommandToken(target.id) &&
									props.row.kind !== "infrastructure" &&
									["run", "build", "test"].includes(String(target.action))
								}
							>
								<ActionHeader
									scope={controls()}
									interactive={active() && props.fresh && props.connected}
									onActivate={() => {
										if (
											targetMember(target) &&
											resourceCommandToken(props.row.id) &&
											resourceCommandToken(target.id)
										)
											prepare(
												`/${String(target.action)} ${props.row.id} ${target.id}`,
											);
									}}
								>
									<text fg={color("accent")}>
										Prepare supplied {String(target.action)} task; native exact
										approval remains required
									</text>
								</ActionHeader>
							</Show>
						</box>
					)}
				</SuppliedRecordWindow>
				<SuppliedRecordWindow
					rows={runs()}
					scope={source()}
					label="run observations"
					title={(run) =>
						`${String(run.id ?? "not supplied")} · ${String(run.state ?? "unknown")} · owner ${String(run.owner ?? "not supplied")}`
					}
					search={(run) => JSON.stringify(run)}
				>
					{(run, index) => (
						<box
							flexDirection="column"
							border={["top"]}
							borderColor={color("border")}
							gap={1}
						>
							<text wrapMode="word">
								{index() + 1}. Run {String(run.id ?? "identity not supplied")} ·{" "}
								{String(run.state ?? "state not supplied")} · owner #
								{String(run.owner ?? "not supplied")} · recorded readiness{" "}
								{String(run.ready ?? "unknown")} · revision{" "}
								{String(run.revision ?? "not supplied")}
							</text>
							<Show when={runMember(run) && taskId(run.owner)}>
								<ActionHeader
									scope={controls()}
									interactive={active()}
									onActivate={() => {
										if (active() && runMember(run) && taskId(run.owner))
											props.openTask(run.owner);
									}}
								>
									<text fg={color("accent")}>
										Open exact supplied owner task (not lease adoption)
									</text>
								</ActionHeader>
							</Show>
							<Show when={!runMember(run)}>
								<text fg={color("warning")}>
									Ambiguous supplied run identity; owner navigation disabled.
								</text>
							</Show>
							{disclosure(
								`run:${index()}`,
								"Supplied run / idle / cleanup record; not lease authority",
								run,
							)}
						</box>
					)}
				</SuppliedRecordWindow>
				{disclosure(
					"waiters",
					"Supplied matching acquisition waiters",
					waiters(),
				)}
				<Show when={resourceCommandToken(props.row.id)}>
					<ActionHeader
						scope={controls()}
						interactive={active() && props.fresh && props.connected}
						onActivate={() => {
							if (resourceCommandToken(props.row.id))
								prepare(`/logs ${props.row.id}`);
						}}
					>
						<text fg={color("accent")}>
							Prepare explicit logs read (no restart, release or takeover)
						</text>
					</ActionHeader>
				</Show>
			</Show>
		</box>
	);
}
