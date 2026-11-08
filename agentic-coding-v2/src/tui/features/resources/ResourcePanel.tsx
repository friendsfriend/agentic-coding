/** @jsxImportSource @opentui/solid */
import { For, type JSX, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { Selectable } from "../../presentation/components/Selectable.tsx";
import { ActionHeader as NativeActionHeader } from "../../ui/ActionHeader.tsx";
import type { LocalChoice } from "../../ui/LocalChoice.ts";
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
	scope: object;
	interactive: boolean;
	fresh: boolean;
	choose: (choice: LocalChoice) => void;
	kind: "schedules" | "environments";
	rows: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	environments: Data | undefined;
	connected: boolean;
	expanded: string[];
	toggle: (key: string) => void;
	prepare: (command: string) => boolean;
	openTask: (id: number) => void;
}) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const ActionHeader = (action: {
		onActivate: () => void;
		children: JSX.Element;
	}) => (
		<NativeActionHeader
			scope={props.scope}
			interactive={props.interactive}
			onActivate={action.onActivate}
		>
			{action.children}
		</NativeActionHeader>
	);
	const member = (row: Data) =>
		!disposed &&
		props.rows.filter((entry) => entry.id === row.id).length === 1 &&
		props.rows.some(
			(entry) =>
				entry.id === row.id && JSON.stringify(entry) === JSON.stringify(row),
		);
	const select = (row: Data) => {
		const index = props.rows.findIndex((entry) => entry.id === row.id);
		if (props.interactive && member(row) && index >= 0)
			props.select(row, index);
	};
	const prepare = (row: Data, command: string) =>
		props.interactive && props.fresh && member(row) && props.prepare(command);
	const targetChoice = (row: Data, action: string) => {
		if (
			!props.interactive ||
			!props.fresh ||
			!member(row) ||
			row.kind === "infrastructure" ||
			!commandToken(row.id)
		)
			return;
		const scope = props.scope,
			signature = JSON.stringify(row);
		const targets = dataList(row.targets).filter(
			(target, _index, all) =>
				target.action === action &&
				commandToken(target.id) &&
				all.filter((entry) => entry.id === target.id).length === 1,
		);
		const valid = () =>
			!disposed &&
			props.fresh &&
			props.scope === scope &&
			member(row) &&
			JSON.stringify(props.rows.find((entry) => entry.id === row.id)) ===
				signature;
		props.choose({
			title: `Choose ${action} target · ${String(row.id)}`,
			rows: targets.map((target) => ({
				key: String(target.id),
				label: String(target.id),
				detail: `${String(target.runtime)} · profile: ${String(target.profile ?? "not supplied")} · availability: ${JSON.stringify(target.availability ?? "not supplied")}`,
			})),
			note: "Supplied runtime/profile bundle · command preparation only · native approval still required",
			valid,
			choose: (key) => {
				if (!valid() || !targets.some((target) => target.id === key))
					return false;
				return props.prepare(`/${action} ${String(row.id)} ${key}`);
			},
		});
	};
	const details = (key: string, label: string, value: unknown) => (
		<>
			<ActionHeader
				onActivate={() => {
					if (props.interactive && !disposed) props.toggle(key);
				}}
			>
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
						onMouseUp={() => select(row)}
					>
						<box flexDirection="column" gap={1}>
							<ActionHeader onActivate={() => select(row)}>
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
											onActivate={() => {
												if (
													props.interactive &&
													member(row) &&
													Number.isSafeInteger(row.activeTask) &&
													Number(row.activeTask) > 0
												)
													props.openTask(Number(row.activeTask));
											}}
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
												prepare(
													row,
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
									<For
										each={["run", "build", "test"].filter((action) =>
											dataList(row.targets).some(
												(target) => target.action === action,
											),
										)}
									>
										{(action) => (
											<ActionHeader
												onActivate={() => targetChoice(row, action)}
											>
												<text fg={color("accent")}>
													Choose {action} target/profile bundle (prepare only)
												</text>
											</ActionHeader>
										)}
									</For>
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
															prepare(
																row,
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
													onActivate={() => {
														if (
															props.interactive &&
															member(row) &&
															Number.isSafeInteger(run.owner) &&
															Number(run.owner) > 0
														)
															props.openTask(Number(run.owner));
													}}
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
											onActivate={() => prepare(row, `/logs ${String(row.id)}`)}
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
