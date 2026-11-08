/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, SyntaxStyle } from "@opentui/core";
import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalChoiceContext } from "../../ui/LocalChoice.ts";
import { color } from "../../ui/theme/index.ts";
import { TranscriptRowsContext } from "./TranscriptRows.ts";

/** Bounded local windows over exactly supplied text. Never a file read, patch,
 * source discovery, execution observation or native history operation. */
export function SuppliedCode(props: {
	content: string;
	identity?: string;
	filetype?: string;
	syntax: SyntaxStyle;
	lineNumbers?: boolean;
	startLine?: number;
	fg?: string;
	lineNumberFg?: string;
}) {
	const choices = useContext(LocalChoiceContext),
		reading = useContext(TranscriptRowsContext),
		localId = createUniqueId();
	const [node, setNode] = createSignal<BoxRenderable>(),
		[anchorEpoch, setAnchorEpoch] = createSignal(0);
	const [selected, setSelected] = createSignal(0);
	let disposed = false;
	const source = createMemo(
		() => ({
			identity: props.identity,
			content: props.content,
			filetype: props.filetype,
			startLine: props.startLine,
			scope: choices?.scope(),
		}),
		undefined,
		{
			equals: (a, b) =>
				a.identity === b.identity &&
				a.content === b.content &&
				a.filetype === b.filetype &&
				a.startLine === b.startLine &&
				a.scope === b.scope,
		},
	);
	let previous: ReturnType<typeof source> | undefined;
	createEffect(() => {
		const current = source();
		const appended =
			previous &&
			previous.scope === current.scope &&
			previous.identity === current.identity &&
			previous.filetype === current.filetype &&
			previous.startLine === current.startLine &&
			current.content.startsWith(previous.content);
		if (!appended) {
			setSelected(0);
			setAnchorEpoch((value) => value + 1);
		}
		previous = current;
	});
	createEffect(() => {
		const row = node(),
			generation = anchorEpoch();
		if (row && reading)
			onCleanup(
				reading.register(
					JSON.stringify(["ui-source-window", localId, generation]),
					row,
				),
			);
	});
	onCleanup(() => {
		disposed = true;
	});
	const windows = createMemo(() => {
		const text = props.content;
		const result: {
			start: number;
			end: number;
			line: number;
			continued: boolean;
		}[] = [];
		let start = 0,
			line = 1;
		do {
			const limit = Math.min(text.length, start + 24000);
			let end = limit,
				position = start,
				count = 0;
			while (position < limit && count < 200) {
				const newline = text.indexOf("\n", position);
				if (newline < 0 || newline >= limit) break;
				position = newline + 1;
				count++;
				if (count === 200) end = position;
			}
			// Keep a supplied surrogate pair together without normalizing its bytes.
			if (
				end < text.length &&
				end > start &&
				text.charCodeAt(end - 1) >= 0xd800 &&
				text.charCodeAt(end - 1) <= 0xdbff &&
				text.charCodeAt(end) >= 0xdc00 &&
				text.charCodeAt(end) <= 0xdfff
			)
				end--;
			result.push({
				start,
				end,
				line,
				continued: start > 0 && text[start - 1] !== "\n",
			});
			line += (text.slice(start, end).match(/\n/g) ?? []).length;
			start = end;
		} while (start < text.length);
		return result;
	});
	const window = () => windows()[selected()] ?? windows()[0];
	const interactive = () => !disposed && (choices?.interactive() ?? true);
	const scope = createMemo(() => [
		source(),
		selected(),
		choices?.scope(),
		interactive(),
	]);
	const applyWindow = (index: number) => {
		setSelected(index);
		const row = node();
		if (row && !row.isDestroyed)
			reading?.reveal(
				JSON.stringify(["ui-source-window", localId, anchorEpoch()]),
				row,
			);
	};
	const move = (index: number) => {
		if (
			interactive() &&
			Number.isSafeInteger(index) &&
			index >= 0 &&
			index < windows().length
		)
			applyWindow(index);
	};
	const choose = () => {
		if (!interactive() || !choices) return;
		const captured = source(),
			origin = choices.scope(),
			index = selected();
		const valid = () =>
			!disposed &&
			source() === captured &&
			choices.scope() === origin &&
			selected() === index;
		choices.choose({
			title: "Choose a supplied text window",
			rows: windows().map((item, i) => ({
				key: String(i),
				label: `Body line ${item.line} · UTF-16 positions ${item.start + 1}–${item.end}`,
				detail: `Window ${i + 1}/${windows().length}${item.continued ? " · begins within a continued line" : ""}`,
			})),
			initialKey: String(index),
			note: "Local supplied-body positions only · no filesystem/history reads, provenance inference or execution",
			valid,
			choose: (key) => {
				const next = Number(key);
				if (
					!valid() ||
					!/^\d+$/.test(key) ||
					!Number.isSafeInteger(next) ||
					next < 0 ||
					next >= windows().length
				)
					return false;
				applyWindow(next);
				return true;
			},
		});
	};
	const code = () => (
		<code
			content={props.content.slice(window()?.start ?? 0, window()?.end ?? 0)}
			filetype={props.filetype}
			syntaxStyle={props.syntax}
			drawUnstyledText
			fg={props.fg}
			wrapMode="word"
		/>
	);
	return (
		<box flexDirection="column" flexShrink={0} ref={setNode}>
			<Show when={windows().length > 1}>
				<text fg={color("textMuted")} wrapMode="word">
					Supplied text window {selected() + 1}/{windows().length} · body line{" "}
					{window()?.line} · UTF-16 positions {(window()?.start ?? 0) + 1}–
					{window()?.end} of {props.content.length}. Other windows remain
					available locally; highlighting is window-local, not a complete syntax
					or execution observation.
					{window()?.continued
						? " This window starts within a continued line."
						: ""}
				</text>
				<Show when={selected() > 0}>
					<ActionHeader
						scope={scope()}
						interactive={interactive()}
						onActivate={() => move(selected() - 1)}
					>
						<text fg={color("accent")}>Previous supplied text window</text>
					</ActionHeader>
				</Show>
				<Show when={choices}>
					<ActionHeader
						scope={scope()}
						interactive={interactive()}
						onActivate={choose}
					>
						<text fg={color("accent")}>Choose supplied body range</text>
					</ActionHeader>
				</Show>
				<Show when={selected() + 1 < windows().length}>
					<ActionHeader
						scope={scope()}
						interactive={interactive()}
						onActivate={() => move(selected() + 1)}
					>
						<text fg={color("accent")}>Next supplied text window</text>
					</ActionHeader>
				</Show>
			</Show>
			<Show when={props.lineNumbers} fallback={code()}>
				<line_number
					fg={props.lineNumberFg ?? color("textMuted")}
					minWidth={3}
					paddingRight={1}
					lineNumberOffset={
						(Number.isSafeInteger(props.startLine) &&
						Number(props.startLine) >= 1
							? Number(props.startLine)
							: 1) +
						(window()?.line ?? 1) -
						2
					}
				>
					{code()}
				</line_number>
			</Show>
		</box>
	);
}
