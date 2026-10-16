/** @jsxImportSource @opentui/solid */
// The bounded numeric editor (add-agent-compaction, design D8). Settings had no
// numeric editor at all: the profile/preset form's `text` field cannot express
// "a whole number within bounds, or the field's documented percentage form", and
// a compaction threshold is exactly that. One overlay serves every token field,
// so the interaction, its bounds and its message exist once.
//
// The pure half (`compactionEditorField`, `acceptEditorKeystroke`,
// `readEditorDraft`) is what the shell's key dispatch and its tests use; the
// component below only renders the draft the shell owns, exactly as the theme
// picker renders the filter the shell owns.
import { GenericModal, uiColors } from "@ui";
import { Show } from "solid-js";
import {
	COMPACTION_PERCENT_MAX,
	COMPACTION_PERCENT_MIN,
	COMPACTION_TOKEN_CEILING,
	type CompactionTokenField,
	compactionFieldMinimum,
	validateCompactionField,
} from "../../workflow/compaction.ts";

export interface NumberEditorField {
	readonly field: CompactionTokenField;
	/** Human label of the field, as the section row words it. */
	readonly label: string;
	/** What the value does, for the dialog's own context line. */
	readonly description: string;
	/** Smallest accepted whole number (absolute form). */
	readonly min: number;
	/** Largest accepted whole number. */
	readonly max: number;
}

/** Label and purpose of each editable token field, in section order. */
const EDITOR_FIELDS: Readonly<
	Record<CompactionTokenField, { label: string; description: string }>
> = {
	reserveTokens: {
		label: "Reserve tokens",
		description:
			"Room kept free for the answer: a request above window − reserve waits for a summary.",
	},
	backgroundTokens: {
		label: "Background starts",
		description:
			"How far below the blocking threshold a summary starts in the background. 0 disables it.",
	},
	keepRecentTokens: {
		label: "Kept verbatim",
		description:
			"Recent context a summary keeps word for word; a percentage scales with each run's window.",
	},
};

/** The editor's own description of one field, bounds included. */
export function compactionEditorField(
	field: CompactionTokenField,
): NumberEditorField {
	const meta = EDITOR_FIELDS[field];
	return {
		field,
		label: meta.label,
		description: meta.description,
		min: compactionFieldMinimum(field),
		max: COMPACTION_TOKEN_CEILING,
	};
}

/** Longest draft the editor accepts: a ceiling-sized number plus a `%`. */
const MAX_DRAFT_LENGTH = 10;

/**
 * Accept one keystroke into the draft. Only what can be part of a valid value is
 * taken: digits, and one trailing `%` (so `15` then `%` is `15%`). Anything else
 * leaves the draft unchanged, which is what "the editor SHALL NOT accept it"
 * means — the entry can never *become* invalid by typing.
 */
export function acceptEditorKeystroke(draft: string, key: string): string {
	if (/^[0-9]$/.test(key))
		// A digit typed after the `%` continues the number instead of leaving an
		// unusable `45%6` behind.
		return `${draft.replace(/%/g, "")}${key}`.slice(0, MAX_DRAFT_LENGTH);
	if (key === "%" && !draft.includes("%") && /[0-9]/.test(draft))
		return `${draft}%`.slice(0, MAX_DRAFT_LENGTH);
	return draft;
}

/** One draft's verdict: the value to store, or the message to show inline. */
export type EditorDraftResult =
	| { readonly ok: true; readonly value: number | string }
	| { readonly ok: false; readonly message: string };

/**
 * Read a draft as the value to persist, judged by the same pure rules the host
 * resolves with — so what the editor accepts is exactly what a durable run can
 * use, and a rejection names the field.
 */
export function readEditorDraft(
	field: CompactionTokenField,
	draft: string,
): EditorDraftResult {
	const text = draft.trim();
	if (!text) return { ok: false, message: "enter a value" };
	const percent = /^(\d{1,3})%$/.exec(text);
	if (percent) {
		const value = Number(percent[1]);
		if (value < COMPACTION_PERCENT_MIN || value > COMPACTION_PERCENT_MAX)
			return {
				ok: false,
				message: `percentage must be between ${COMPACTION_PERCENT_MIN}% and ${COMPACTION_PERCENT_MAX}%`,
			};
		return { ok: true, value: `${value}%` };
	}
	if (!/^\d+$/.test(text))
		return {
			ok: false,
			message: 'whole numbers only, or a percentage like "15%"',
		};
	const value = Number(text);
	const problem = validateCompactionField(field, value);
	if (problem) return { ok: false, message: problem };
	return { ok: true, value };
}

export interface NumberEditorProps {
	readonly target: NumberEditorField;
	/** What the editor was opened with, so cancelling is visibly a no-op. */
	readonly original: string;
	/** The current text, rendered with a live cursor. */
	readonly value: string;
	/** Inline validation message; absent while the entry is acceptable. */
	readonly error?: string;
	/** What the durable host would resolve from this entry, when known. */
	readonly resolved?: string;
}

/** The dialog's help entries, rendered by the shell footer as well. */
export const NUMBER_EDITOR_HELP: readonly {
	readonly key: string;
	readonly action: string;
}[] = [
	{ key: "0-9 %", action: "Type a value" },
	{ key: "Backspace", action: "Delete" },
	{ key: "Enter", action: "Save" },
	{ key: "Esc", action: "Cancel" },
];

export function NumberEditor(props: NumberEditorProps) {
	const bounds = () =>
		`${props.target.min}–${props.target.max} tokens, or ${COMPACTION_PERCENT_MIN}%–${COMPACTION_PERCENT_MAX}% of the run's window`;
	return (
		<GenericModal
			dismissKind="number-editor"
			title={`${props.target.label} · compaction`}
			widthPercent={0.6}
			heightLines={9}
			help={[...NUMBER_EDITOR_HELP]}
		>
			<box style={{ flexDirection: "column", width: "100%" }}>
				<text fg={uiColors.textMuted}>{props.target.description}</text>
				<box style={{ height: 1 }} />
				<text fg={uiColors.textPrimary}>
					{props.value}
					<text fg={uiColors.accent}>█</text>
				</text>
				<box style={{ height: 1 }} />
				<Show when={props.error}>
					{(message) => <text fg={uiColors.error}>{message()}</text>}
				</Show>
				<Show when={!props.error && props.resolved}>
					{(resolved) => <text fg={uiColors.textMuted}>{resolved()}</text>}
				</Show>
				<box style={{ height: 1 }} />
				<text fg={uiColors.textMuted}>
					{bounds()}
					<Show when={props.original}>{` · now ${props.original}`}</Show>
				</text>
			</box>
		</GenericModal>
	);
}
