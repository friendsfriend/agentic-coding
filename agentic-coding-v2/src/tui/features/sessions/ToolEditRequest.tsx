/** @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { type JSX, Show } from "solid-js";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
import { SuppliedCode } from "./SuppliedCode.tsx";

/** Local display keys and supplied fragments, not file or operation identities. */
export type SuppliedEditReplacement = {
	readonly key: string;
	readonly label: string;
	readonly oldText: string;
	readonly newText: string;
};

/** Read-only replacement intent. Projection, native diff gating and disclosure
 * state remain with the owning card. No layout wrapper or event policy is added. */
export function ToolEditRequest(props: {
	replacements: readonly SuppliedEditReplacement[];
	scope: unknown;
	identity: string;
	interactive?: boolean;
	phase: "Partial generated" | "Live slot" | "Requested";
	syntax: SyntaxStyle;
	open: (suffix: string) => boolean;
	fold: (suffix: string, label: string) => JSX.Element;
}) {
	return (
		<Show when={props.replacements.length > 0}>
			<SuppliedRecordWindow
				interactive={props.interactive}
				rows={props.replacements}
				scope={props.scope}
				label="supplied replacement intents"
				title={(edit) => edit.label}
				search={(edit) => JSON.stringify(edit)}
			>
				{(edit) => (
					<>
						{props.fold(
							`:replacement:${edit.key}`,
							`${props.phase} ${edit.label}`,
						)}
						<Show when={props.open(`:replacement:${edit.key}`)}>
							<text fg={color("textMuted")} wrapMode="word">
								Supplied replacement intent — not an applied diff, live file
								snapshot or file-line range.
							</text>
							<text fg={color("textMuted")}>
								Requested old text ·{" "}
								{edit.oldText.length === 0
									? "empty string"
									: "supplied fragment"}
							</text>
							<SuppliedCode
								interactive={props.interactive}
								identity={`${props.identity}:${props.phase}:${edit.key}:old`}
								content={edit.oldText}
								filetype="text"
								syntax={props.syntax}
							/>
							<text fg={color("textMuted")}>
								Requested new text ·{" "}
								{edit.newText.length === 0
									? "empty string"
									: "supplied fragment"}
							</text>
							<SuppliedCode
								interactive={props.interactive}
								identity={`${props.identity}:${props.phase}:${edit.key}:new`}
								content={edit.newText}
								filetype="text"
								syntax={props.syntax}
							/>
						</Show>
					</>
				)}
			</SuppliedRecordWindow>
		</Show>
	);
}
