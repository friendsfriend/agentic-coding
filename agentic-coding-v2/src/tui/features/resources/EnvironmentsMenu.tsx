/** @jsxImportSource @opentui/solid */
// Environments as the original TUI composed it: a menu of categories, each
// opening a list of resource cards, each card opening the resource's detail.
// Operations and diagnostics are menu destinations of their own. Everything is
// read from the supplied snapshot; actions only prepare unsent commands.
import { TextAttributes } from "@opentui/core";
import {
	createMemo,
	createSignal,
	type JSX,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import type { UiResourcePreferences } from "../../../protocol/viewpoints.ts";
import { dataList } from "../../client/connection.ts";
import {
	type CardEntry,
	CardList,
} from "../../presentation/components/CardList.tsx";
import { useTerminalDimensions } from "../../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../../presentation/theme/colors";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import type { LocalChoice } from "../../ui/LocalChoice.ts";
import { type MenuKey, useMenuKeys } from "../../ui/menuKeys.ts";
import { color } from "../../ui/theme/index.ts";
import {
	resourceCommandToken as commandToken,
	ResourceDetails,
} from "./ResourceDetails.tsx";

type Category = "app" | "library" | "infrastructure";
type Level =
	| { kind: "menu" }
	| { kind: "list"; category: Category }
	| { kind: "detail"; category: Category; id: string }
	| { kind: "operations" }
	| { kind: "diagnostics" };

const CATEGORY_LABELS: Record<Category, string> = {
	app: "Applications",
	library: "Libraries",
	infrastructure: "Infrastructure",
};
const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
	app: "Run, inspect and act on applications",
	library: "Built libraries and their targets",
	infrastructure: "Infrastructure services and their logs",
};

export function EnvironmentsMenu(props: {
	scope: object;
	preferences: UiResourcePreferences;
	changePreferences: (next: UiResourcePreferences) => boolean;
	inventory: Data[];
	rows: Data[];
	environments: Data | undefined;
	interactive: boolean;
	connected: boolean;
	fresh: boolean;
	expanded: string[];
	toggle: (key: string) => void;
	select: (row: Data, index: number) => void;
	choose: (choice: LocalChoice) => void;
	prepare: (command: string) => boolean;
	openTask: (id: number) => void;
	keys: () => boolean;
	operations: () => JSX.Element;
	diagnostics: () => JSX.Element;
}) {
	const dimensions = useTerminalDimensions();
	const [level, setLevel] = createSignal<Level>({ kind: "menu" });
	const [menuIndex, setMenuIndex] = createSignal(0);
	const [listIndex, setListIndex] = createSignal(0);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const runs = () => dataList(props.environments?.runs);
	const running = (id: unknown) =>
		runs().filter(
			(run) =>
				run.plan &&
				typeof run.plan === "object" &&
				(run.plan as Data).app === id,
		);
	const ofCategory = (category: Category) =>
		props.rows.filter((row) => row.kind === category);
	const unique = (row: Data) =>
		!disposed &&
		typeof row.id === "string" &&
		row.id.length > 0 &&
		props.inventory.filter((entry) => entry.id === row.id).length === 1 &&
		props.rows.filter((entry) => entry.id === row.id).length === 1;
	const menuEntries = createMemo((): (CardEntry & { open: () => void })[] => [
		...(["app", "library", "infrastructure"] as const).map((category) => {
			const rows = ofCategory(category);
			const active = rows.filter((row) => running(row.id).length > 0).length;
			return {
				id: category,
				title: CATEGORY_LABELS[category],
				detail: CATEGORY_DESCRIPTIONS[category],
				value:
					category === "library"
						? `${rows.length}`
						: `${active}/${rows.length} running`,
				open: () => {
					setListIndex(0);
					setLevel({ kind: "list", category });
				},
			};
		}),
		{
			id: "operations",
			title: "Operations",
			detail: "Read logs, drafts and native intentions",
			open: () => setLevel({ kind: "operations" }),
		},
		{
			id: "diagnostics",
			title: "Diagnostics",
			detail: "Prepare a diagnostic request for a task or session",
			open: () => setLevel({ kind: "diagnostics" }),
		},
	]);
	const listEntries = (category: Category): CardEntry[] =>
		ofCategory(category).map((row) => {
			const active = running(row.id);
			const pinned = props.preferences.pins.includes(String(row.id));
			return {
				id: String(row.id),
				title: `${category === "infrastructure" ? "▣" : category === "app" ? "◆" : "◇"} ${String(row.id ?? "identity not supplied")}${pinned ? " ·  pinned" : ""}`,
				detail: unique(row)
					? String(row.repository ?? "repository not supplied")
					: "Identity is missing or ambiguous · navigation disabled",
				tone: unique(row) ? undefined : "warning",
				value:
					active.length > 0
						? `running · ${active.length}`
						: `${dataList(row.targets).length} targets`,
				accent: active.length > 0 ? uiColors.success : undefined,
			};
		});
	const detailRow = createMemo(() => {
		const current = level();
		if (current.kind !== "detail") return undefined;
		return props.rows.find((row) => row.id === current.id);
	});
	const openRow = (category: Category, index: number) => {
		const row = ofCategory(category)[index];
		if (!row || !unique(row) || !props.interactive) return;
		props.select(row, props.rows.indexOf(row));
		setLevel({ kind: "detail", category, id: String(row.id) });
	};
	const targetChoice = (row: Data, action: string) => {
		if (
			!props.interactive ||
			!props.fresh ||
			!unique(row) ||
			row.kind === "infrastructure" ||
			!commandToken(row.id)
		)
			return;
		const signature = JSON.stringify(row),
			scope = props.scope;
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
			unique(row) &&
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
			choose: (key) =>
				valid() &&
				targets.some((target) => target.id === key) &&
				props.prepare(`/${action} ${String(row.id)} ${key}`),
		});
	};
	const togglePin = (row: Data) => {
		if (!props.interactive || !unique(row) || typeof row.id !== "string")
			return;
		props.changePreferences({
			...props.preferences,
			pins: props.preferences.pins.includes(row.id)
				? props.preferences.pins.filter((id) => id !== row.id)
				: [...props.preferences.pins, row.id],
		});
	};
	const clamp = (value: number, length: number) =>
		Math.max(0, Math.min(value, Math.max(0, length - 1)));
	const key = (input: MenuKey): boolean | undefined => {
		const current = level();
		const step = input === "up" ? -1 : input === "down" ? 1 : 0;
		if (current.kind === "menu") {
			const entries = menuEntries();
			if (input === "back" || input === "left") return false;
			if (step) setMenuIndex(clamp(menuIndex() + step, entries.length));
			else if (input === "open" || input === "right")
				entries[clamp(menuIndex(), entries.length)]?.open();
			return;
		}
		if (current.kind === "list") {
			const length = ofCategory(current.category).length;
			if (step) setListIndex(clamp(listIndex() + step, length));
			else if (input === "open" || input === "right")
				openRow(current.category, clamp(listIndex(), length));
			else setLevel({ kind: "menu" });
			return;
		}
		if (input === "back" || input === "left")
			setLevel(
				current.kind === "detail"
					? { kind: "list", category: current.category }
					: { kind: "menu" },
			);
	};
	useMenuKeys({ active: props.keys, key });
	const lines = () => Math.max(4, dimensions().height - 14);
	const path = () => {
		const current = level();
		switch (current.kind) {
			case "menu":
				return "";
			case "list":
				return CATEGORY_LABELS[current.category];
			case "detail":
				return `${CATEGORY_LABELS[current.category]} › ${current.id}`;
			case "operations":
				return "Operations";
			case "diagnostics":
				return "Diagnostics";
		}
	};
	return (
		<box flexDirection="column" gap={1} backgroundColor={uiColors.bgBase}>
			<box flexDirection="row">
				<Show when={path()}>
					<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
						{path()}
					</text>
					<text fg={uiColors.textMuted}>{"  ·  "}</text>
				</Show>
				<text fg={props.connected ? uiColors.textMuted : uiColors.warning}>
					{props.connected
						? `${props.inventory.length} resources · ${runs().length} runs`
						: "Disconnected · showing the last read"}
				</text>
			</box>
			<Switch>
				<Match when={level().kind === "menu"}>
					<CardList
						entries={menuEntries()}
						selectedIndex={menuIndex()}
						availableLines={lines()}
						onSelect={setMenuIndex}
						onActivate={(index) => {
							setMenuIndex(index);
							menuEntries()[index]?.open();
						}}
					/>
				</Match>
				<Match
					when={(() => {
						const current = level();
						return current.kind === "list" ? current : undefined;
					})()}
				>
					{(current) => (
						<CardList
							entries={listEntries(current().category)}
							selectedIndex={listIndex()}
							availableLines={lines()}
							onSelect={setListIndex}
							onActivate={(index) => {
								setListIndex(index);
								openRow(current().category, index);
							}}
							empty={
								<text fg={uiColors.textMuted}>
									{`No ${CATEGORY_LABELS[current().category].toLowerCase()} configured.`}
								</text>
							}
						/>
					)}
				</Match>
				<Match when={level().kind === "detail"}>
					<Show
						when={detailRow()}
						fallback={
							<text fg={uiColors.warning}>
								This resource is no longer in the supplied inventory.
							</text>
						}
					>
						{(row) => (
							<box flexDirection="column" gap={1}>
								<ActionHeader
									scope={[props.scope, props.preferences, row()]}
									interactive={props.interactive}
									onActivate={() => togglePin(row())}
								>
									<text fg={color("accent")}>
										{props.preferences.pins.includes(String(row().id))
											? "Unpin"
											: "Pin"}
									</text>
								</ActionHeader>
								<ResourceDetails
									row={row()}
									kind="environments"
									scope={props.scope}
									environments={props.environments}
									interactive={props.interactive}
									connected={props.connected}
									fresh={props.fresh}
									member={() => unique(row())}
									expanded={props.expanded}
									toggle={props.toggle}
									prepare={(command) =>
										props.interactive &&
										props.fresh &&
										unique(row()) &&
										props.prepare(command)
									}
									openTask={props.openTask}
									chooseTarget={(action) => targetChoice(row(), action)}
								/>
							</box>
						)}
					</Show>
				</Match>
				<Match when={level().kind === "operations"}>{props.operations()}</Match>
				<Match when={level().kind === "diagnostics"}>
					{props.diagnostics()}
				</Match>
			</Switch>
		</box>
	);
}
