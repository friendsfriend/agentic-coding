/** @jsxImportSource @opentui/solid */
import { createMemo, type JSX, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import type { UiResourcePreferences } from "../../../protocol/viewpoints.ts";
import { dataList } from "../../client/connection.ts";
import { Selectable } from "../../presentation/components/Selectable.tsx";
import { ActionHeader as NativeActionHeader } from "../../ui/ActionHeader.tsx";
import { DetailsFold } from "../../ui/DetailsFold.tsx";
import type { LocalChoice } from "../../ui/LocalChoice.ts";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
import {
	resourceCommandToken as commandToken,
	ResourceDetails,
} from "./ResourceDetails.tsx";

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
		props.environments,
		props.connected,
		props.fresh,
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
		typeof row.id === "string" &&
		row.id.length > 0 &&
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
				detail: `${String(target.runtime)} · ${String(target.profile ?? "no profile")} · ${JSON.stringify(target.availability ?? "not supplied")}`,
			})),
			note: "Supplied target · approval still required",
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
			note: "Display state only",
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
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				{props.kind === "schedules" ? "Schedules" : "Environments"} ·{" "}
				{props.rows.length}
				{props.connected ? "" : " · disconnected, last read"}
			</text>
			<DetailsFold
				label="Filter and order"
				summary={[
					props.filter ? `filter ${props.filter}` : "no filter",
					props.preferences.category ?? "all categories",
					`${props.preferences.order} order`,
					`${props.preferences.pins.length} pinned`,
				].join(" · ")}
				scope={controlScope()}
			>
				<ActionHeader onActivate={searchRows}>
					<text fg={color("accent")}>Find a resource</text>
				</ActionHeader>
				<ActionHeader onActivate={categoryChoice}>
					<text fg={color("accent")}>Category</text>
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
						{props.preferences.pinnedOnly ? "Show all" : "Show pinned only"}
					</text>
				</ActionHeader>
				<ActionHeader
					onActivate={() =>
						displayChoice(
							"Order",
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
					<text fg={color("accent")}>Order</text>
				</ActionHeader>
				<ActionHeader
					onActivate={() => {
						if (props.interactive) props.prepare("/filter ");
					}}
				>
					<text fg={color("accent")}>Filter text</text>
				</ActionHeader>
			</DetailsFold>
			<Show when={props.rows.length === 0}>
				<text fg={color("textMuted")}>
					{props.inventory.length === 0
						? "Nothing configured yet."
						: "No rows match the filter."}
				</text>
			</Show>
			<SuppliedRecordWindow
				rows={props.rows}
				scope={props.scope}
				label="resource records"
				title={(row) =>
					`${String(row.id ?? "identity not supplied")} · ${String(row.state ?? row.kind ?? "unknown")}`
				}
				search={(row) => JSON.stringify(row)}
				selected={props.selected}
				pick={(row, index) => {
					if (!member(row)) return false;
					props.select(row, index);
					return true;
				}}
			>
				{(row, index) => (
					<Selectable
						selected={props.selected(row, index())}
						onMouseUp={() => select(row)}
					>
						<box flexDirection="column" gap={1}>
							<ActionHeader onActivate={() => select(row)}>
								<box flexDirection="row">
									<text fg={color("primary")}>
										{props.selected(row, index()) ? "▾" : "▸"}{" "}
										{String(row.kind ?? row.state ?? "resource")} ·{" "}
										{String(row.id ?? "identity not supplied")}
									</text>
									<text fg={color("textMuted")}>
										{` — ${String(row.state ?? "state not supplied")}`}
										{props.preferences.pins.includes(String(row.id))
											? " · pinned"
											: ""}
									</text>
								</box>
							</ActionHeader>
							<Show when={!member(row)}>
								<text fg={color("warning")}>
									Identity is missing or ambiguous · navigation disabled
								</text>
							</Show>
							<Show when={props.selected(row, index())}>
								<ActionHeader onActivate={() => togglePin(row)}>
									<text fg={color("accent")}>
										{props.preferences.pins.includes(String(row.id))
											? "Unpin"
											: "Pin"}
									</text>
								</ActionHeader>
								<ResourceDetails
									row={row}
									kind={props.kind}
									scope={props.scope}
									environments={props.environments}
									interactive={props.interactive}
									connected={props.connected}
									fresh={props.fresh}
									member={() => member(row)}
									expanded={props.expanded}
									toggle={props.toggle}
									prepare={(command) => prepare(row, command)}
									openTask={props.openTask}
									chooseTarget={(action) => targetChoice(row, action)}
								/>
							</Show>
						</box>
					</Selectable>
				)}
			</SuppliedRecordWindow>
		</box>
	);
}
