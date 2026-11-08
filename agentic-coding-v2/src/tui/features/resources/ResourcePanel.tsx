/** @jsxImportSource @opentui/solid */
import { createMemo, For, type JSX, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import type { UiResourcePreferences } from "../../../protocol/viewpoints.ts";
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
	preferences: UiResourcePreferences;
	changePreferences: (next: UiResourcePreferences) => boolean;
	filter: string;
	inventory: Data[];
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
	const controlScope = createMemo(() => [
		props.scope,
		props.preferences,
		props.rows,
		props.inventory,
		props.filter,
		props.interactive,
	]);
	const ActionHeader = (action: {
		onActivate: () => void;
		children: JSX.Element;
	}) => (
		<NativeActionHeader
			scope={controlScope()}
			interactive={props.interactive}
			onActivate={action.onActivate}
		>
			{action.children}
		</NativeActionHeader>
	);
	const member = (row: Data) =>
		!disposed &&
		props.inventory.filter((entry) => entry.id === row.id).length === 1 &&
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
	const displayChoice = (
		title: string,
		choices: { key: string; label: string; detail?: string }[],
		initialKey: string | undefined,
		apply: (key: string) => boolean,
	) => {
		if (!props.interactive || disposed) return;
		const scope = props.scope,
			signature = JSON.stringify([
				props.inventory,
				props.rows,
				props.preferences,
				props.filter,
			]);
		const valid = () =>
			!disposed &&
			props.scope === scope &&
			JSON.stringify([
				props.inventory,
				props.rows,
				props.preferences,
				props.filter,
			]) === signature;
		props.choose({
			title,
			rows: choices,
			initialKey,
			note: "Local display state only · no reads, execution, leases or approval",
			valid,
			choose: (key) =>
				valid() && choices.some((row) => row.key === key) && apply(key),
		});
	};
	const categoryChoice = () => {
		const categories = [
			...new Set(
				props.inventory
					.map((row) => (props.kind === "environments" ? row.kind : row.state))
					.filter(
						(value): value is string =>
							typeof value === "string" &&
							value.length > 0 &&
							value.length <= 64 &&
							value.trim() === value &&
							[...value].every(
								(character) =>
									character.charCodeAt(0) >= 32 &&
									character.charCodeAt(0) !== 127,
							),
					),
			),
		];
		displayChoice(
			"Choose supplied resource category",
			[
				{ key: "all", label: "All supplied categories" },
				...categories.map((category) => ({
					key: `category:${category}`,
					label: category,
				})),
			],
			props.preferences.category === null
				? "all"
				: `category:${props.preferences.category}`,
			(key) =>
				props.changePreferences({
					...props.preferences,
					category: key === "all" ? null : key.slice(9),
				}),
		);
	};
	const searchRows = () => {
		const candidates = props.rows.filter(
			(row, _index, all) =>
				typeof row.id === "string" &&
				props.inventory.filter((entry) => entry.id === row.id).length === 1 &&
				all.filter((entry) => entry.id === row.id).length === 1,
		);
		displayChoice(
			"Find a matching native resource",
			candidates.map((row) => ({
				key: String(row.id),
				label: String(row.id),
				detail: `${String(row.state ?? row.kind)} · ${String(row.repository ?? "repository not supplied")}`,
			})),
			String(props.rows.find(props.selected)?.id ?? ""),
			(key) => {
				const row = props.rows.find((entry) => entry.id === key);
				if (!row || !member(row)) return false;
				props.select(row, props.rows.indexOf(row));
				return true;
			},
		);
	};
	const togglePin = (row: Data) => {
		if (!props.interactive || !member(row) || typeof row.id !== "string")
			return;
		props.changePreferences({
			...props.preferences,
			pins: props.preferences.pins.includes(row.id)
				? props.preferences.pins.filter((id) => id !== row.id)
				: [...props.preferences.pins, row.id],
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
			<box flexDirection="column" gap={1}>
				<text fg={color("textMuted")} wrapMode="word">
					Text filter: {props.filter || "none"} · category:{" "}
					{props.preferences.category ?? "all"} · order:{" "}
					{props.preferences.order} · {props.preferences.pins.length} local pins
					(missing pins retained, never adopted)
				</text>
				<ActionHeader onActivate={searchRows}>
					<text fg={color("accent")}>Search matching resources</text>
				</ActionHeader>
				<ActionHeader onActivate={categoryChoice}>
					<text fg={color("accent")}>Choose supplied category</text>
				</ActionHeader>
				<ActionHeader
					onActivate={() => {
						if (props.interactive)
							props.changePreferences({
								...props.preferences,
								pinnedOnly: !props.preferences.pinnedOnly,
							});
					}}
				>
					<text fg={color("accent")}>
						{props.preferences.pinnedOnly
							? "Show all matching rows"
							: "Show pinned rows only"}
					</text>
				</ActionHeader>
				<ActionHeader
					onActivate={() =>
						displayChoice(
							"Choose local resource ordering",
							[
								{
									key: "inventory",
									label: "Supplied inventory order (respects /sort)",
								},
								{
									key: "identity",
									label: "Identity order (stable; pins first)",
								},
							],
							props.preferences.order,
							(key) =>
								props.changePreferences({
									...props.preferences,
									order: key === "identity" ? "identity" : "inventory",
								}),
						)
					}
				>
					<text fg={color("accent")}>Choose resource ordering</text>
				</ActionHeader>
				<ActionHeader
					onActivate={() => {
						if (props.interactive) props.prepare("/filter ");
					}}
				>
					<text fg={color("accent")}>
						Prepare text filter command (does not replace a draft)
					</text>
				</ActionHeader>
			</box>
			<Show when={props.rows.length === 0}>
				<text fg={color("textMuted")}>
					No supplied rows match these display preferences. Hidden selection is
					retained; no replacement resource is chosen.
				</text>
			</Show>
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
									{props.preferences.pins.includes(String(row.id))
										? " · pinned"
										: ""}
								</text>
							</ActionHeader>
							<Show when={props.selected(row, index())}>
								<ActionHeader onActivate={() => togglePin(row)}>
									<text fg={color("accent")}>
										{props.preferences.pins.includes(String(row.id))
											? "Unpin this resource (display only)"
											: "Pin this resource (display only)"}
									</text>
								</ActionHeader>
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
													{String(target.profile ?? "not supplied")}
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
