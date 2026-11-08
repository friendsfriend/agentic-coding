/** @jsxImportSource @opentui/solid */
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import { ActionHeader } from "./ActionHeader.tsx";
import { LocalChoiceContext } from "./LocalChoice.ts";
import { color } from "./theme/index.ts";

/** Bounded mounting of already supplied records. Ordinals identify display
 * carriers only; they never replace native IDs or initiate another read. */
export function SuppliedRecordWindow<T>(props: {
	rows: readonly T[];
	scope: unknown;
	label: string;
	title: (row: T, index: number) => string;
	search: (row: T, index: number) => string;
	selected?: (row: T, index: number) => boolean;
	pick?: (row: T, index: number) => boolean;
	children: (row: T, index: () => number) => JSX.Element;
}) {
	const choices = useContext(LocalChoiceContext);
	const [start, setStart] = createSignal(0);
	let disposed = false;
	let generation = 0;
	const source = createMemo(() => ({
		rows: props.rows,
		scope: props.scope,
		version: ++generation,
	}));
	createEffect(() => {
		source();
		setStart(0);
	});
	createEffect(() => {
		const rows = source().rows;
		const index = rows.findIndex((row, ordinal) =>
			props.selected?.(row, ordinal),
		);
		if (index >= 0) setStart(Math.floor(index / 20) * 20);
	});
	onCleanup(() => {
		disposed = true;
	});
	const controls = createMemo(() => [source(), start()]);
	const active = () => !disposed && (choices?.interactive() ?? true);
	const choose = () => {
		if (!active() || !choices) return;
		const saved = source();
		const savedStart = start();
		const owner = choices.scope();
		const valid = () =>
			!disposed &&
			source() === saved &&
			start() === savedStart &&
			choices.scope() === owner;
		choices.choose({
			title: `Search supplied ${props.label}`,
			rows: saved.rows.map((row, index) => ({
				key: String(index),
				label: `${index + 1}. ${Array.from(props.title(row, index).replace(/\s+/g, " ")).slice(0, 200).join("")}`,
				search: props.search(row, index),
				detail: "Cached display carrier; not native identity or authority",
			})),
			note: "Local window only; no refresh, inspection, discovery, execution or approval. Replacement withdraws this choice.",
			valid,
			choose: (key) => {
				if (!valid() || !/^\d+$/.test(key)) return false;
				const index = Number(key);
				if (
					!Number.isSafeInteger(index) ||
					index < 0 ||
					index >= saved.rows.length
				)
					return false;
				const row = saved.rows[index];
				if (row === undefined || (props.pick && !props.pick(row, index)))
					return false;
				setStart(Math.floor(index / 20) * 20);
				return true;
			},
		});
	};
	const move = (delta: number) => {
		if (!active()) return;
		setStart((value) =>
			Math.max(
				0,
				Math.min(
					Math.max(0, Math.floor((props.rows.length - 1) / 20) * 20),
					value + delta,
				),
			),
		);
	};
	return (
		<box flexDirection="column" gap={1}>
			<Show when={props.rows.length > 20}>
				<text fg={color("textMuted")}>
					Showing {start() + 1}–{Math.min(props.rows.length, start() + 20)} of{" "}
					{props.rows.length} supplied {props.label}; unmounted records remain
					searchable.
				</text>
				<box flexDirection="row" gap={2}>
					<ActionHeader
						scope={controls()}
						interactive={active() && start() > 0}
						onActivate={() => move(-20)}
					>
						<text fg={color("accent")}>Previous local window</text>
					</ActionHeader>
					<ActionHeader
						scope={controls()}
						interactive={active() && start() + 20 < props.rows.length}
						onActivate={() => move(20)}
					>
						<text fg={color("accent")}>Next local window</text>
					</ActionHeader>
					<ActionHeader
						scope={controls()}
						interactive={active()}
						onActivate={choose}
					>
						<text fg={color("accent")}>Search retained records</text>
					</ActionHeader>
				</box>
			</Show>
			<For each={props.rows.slice(start(), start() + 20)}>
				{(row, index) => props.children(row, () => start() + index())}
			</For>
		</box>
	);
}
