/** @jsxImportSource @opentui/solid */
// The masked credential editor (`add-stage-testing-foundation`, task 5.1).
//
// Settings' Stages rows offer exactly one write: the value of a `.env` variable
// the stage catalog references. The value is typed here, is never rendered in
// clear, is never echoed back and is never stored by the view — the dialog shows
// a bullet per character and a cursor, and the shell holds the draft only while
// this overlay is on top.
//
// The pure half (`acceptCredentialKeystroke`, `maskCredential`,
// `readCredentialDraft`) is what the shell's key dispatch and its tests use; the
// component below only renders the draft the shell owns, exactly as the numeric
// editor renders its own.
import { GenericModal, uiColors, useTerminalDimensions } from "@ui";
import { Show } from "solid-js";

/** Longest draft the editor accepts (the route caps the value at 4096). */
export const MAX_CREDENTIAL_CHARS = 1024;

/** Render a draft as bullets: the value is never shown in clear, not even to
 * the developer who typed it. */
export function maskCredential(value: string): string {
	return "•".repeat([...value].length);
}

/**
 * Fit one line to the columns a dialog row has.
 *
 * A row that is longer than its box does not shrink: it wraps, and a wrapped row
 * paints over whatever the modal put below it (the saved-frames test at 74 and
 * 80 columns is what found the overlapping draft row). Every line this dialog
 * renders is therefore fitted, and a cut line says so with a trailing marker
 * rather than stopping mid-word as though it were the whole sentence.
 */
export function fitLine(text: string, columns: number): string {
	const limit = Math.max(1, Math.floor(columns));
	const characters = [...text];
	if (characters.length <= limit) return text;
	return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/**
 * The columns one content row of this dialog has at a terminal width: the
 * dialog is 60% of the terminal with two columns of padding on each side, less
 * one column so a fitted line and its marker never sit in the last column.
 */
export function credentialContentColumns(terminalColumns: number): number {
	return Math.max(8, Math.floor(terminalColumns * 0.6) - 5);
}

/**
 * Accept one keystroke into the draft. Any printable character is taken — a
 * credential is opaque — and function keys (whose names are longer than one
 * character, or are control codes) are left to the shell's dispatch.
 */
export function acceptCredentialKeystroke(draft: string, key: string): string {
	if (key === "space") return `${draft} `.slice(0, MAX_CREDENTIAL_CHARS);
	if ([...key].length !== 1) return draft;
	const code = key.charCodeAt(0);
	if (code < 0x20 || code === 0x7f) return draft;
	return `${draft}${key}`.slice(0, MAX_CREDENTIAL_CHARS);
}

/** One draft's verdict: the value to store, or the message to show inline. */
export type CredentialDraftResult =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly message: string };

/**
 * Read a draft as the value to persist. Only emptiness is judged here: the
 * server decides whether the variable is one a stage references, and a
 * credential's *shape* is not this layer's business (a trailing space in a
 * secret is a legitimate secret).
 */
export function readCredentialDraft(draft: string): CredentialDraftResult {
	if (draft.length === 0) return { ok: false, message: "enter a value" };
	if (draft.trim().length === 0)
		return { ok: false, message: "a credential cannot be only whitespace" };
	return { ok: true, value: draft };
}

export interface CredentialEditorProps {
	/** What the editor is setting, e.g. "password · clerk · Grid web". */
	readonly label: string;
	/** The `.env` variable the value is written to. */
	readonly variable: string;
	/** The current draft, rendered masked. */
	readonly value: string;
	/** Inline message; absent while the entry is acceptable. */
	readonly error?: string;
	/** True while the write is in flight. */
	readonly saving?: boolean;
}

/** The dialog's help entries. */
export const CREDENTIAL_EDITOR_HELP: readonly {
	readonly key: string;
	readonly action: string;
}[] = [
	{ key: "Type", action: "Enter the secret" },
	{ key: "Backspace", action: "Delete" },
	{ key: "Enter", action: "Save" },
	{ key: "Esc", action: "Cancel" },
];

export function CredentialEditor(props: CredentialEditorProps) {
	const dimensions = useTerminalDimensions();
	const columns = () => credentialContentColumns(dimensions().width);
	/** How many characters the draft holds. Counted like the mask is drawn, so a
	 * draft outside the BMP counts as the one bullet it paints. */
	const length = () => [...props.value].length;
	/** One line, fitted: the variable is named first and the rest is dropped with a
	 * marker long before the sentence would wrap into the rows below it. */
	const intro = () =>
		fitLine(
			`Writes ${props.variable} in the configuration .env — never shown, logged or sent to a run.`,
			columns(),
		);
	return (
		<GenericModal
			dismissKind="stage-credential"
			// The variable first: a narrow terminal clips the title, and the `.env` key
			// the value is written to is the one identity that must survive the clip.
			title={`${props.variable} · ${props.label}`}
			widthPercent={0.6}
			heightLines={14}
			// `?` belongs to the draft: a secret may contain one, and the whole surface
			// is one text field. The modal therefore registers no `? help` overlay (its
			// own key list stays visible as the help line, which is what a dialog of one
			// field needs).
			helpSections={false}
			help={[...CREDENTIAL_EDITOR_HELP]}
		>
			<box style={{ flexDirection: "column", width: "100%" }}>
				<text fg={uiColors.textMuted}>{intro()}</text>
				{/* One row per thing: the masked draft with its cursor, then the counter on
				    a row of its own (side by side, the counter is what falls off the
				    dialog). Every row is fitted, so nothing here can wrap. */}
				<box style={{ flexDirection: "row", height: 1 }}>
					<text fg={uiColors.textPrimary}>
						{fitLine(
							props.value.length > 0 ? maskCredential(props.value) : "(empty)",
							columns() - 2,
						)}
					</text>
					<text fg={uiColors.accent}>█</text>
				</box>
				<text fg={uiColors.textMuted}>
					{fitLine(
						`${length()}/${MAX_CREDENTIAL_CHARS} · Enter saves only this key`,
						columns(),
					)}
				</text>
				<Show when={props.error}>
					{(message) => (
						<text fg={uiColors.error}>{fitLine(message(), columns())}</text>
					)}
				</Show>
				<Show when={!props.error && props.saving}>
					<text fg={uiColors.textMuted}>
						{fitLine(
							"saving… Esc still cancels (the write already sent cannot be recalled)",
							columns(),
						)}
					</text>
				</Show>
			</box>
		</GenericModal>
	);
}
