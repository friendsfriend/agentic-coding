/** @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { type JSX, Show } from "solid-js";
import { color } from "../../ui/theme/index.ts";
import { SuppliedCode } from "./SuppliedCode.tsx";

/** Supplied UI bytes only; no native result, execution or authority identity. */
export type SuppliedToolSource = {
	readonly content: string;
	readonly filetype: string;
	readonly label: string;
};

/** Local source fold presentation. The owning card retains source projection,
 * native pairing/status and disclosure state. No layout wrapper is added. */
export function ToolRequestedSource(props: {
	source: SuppliedToolSource | null;
	phase: "Partial generated" | "Live slot" | "Requested";
	syntax: SyntaxStyle;
	open: (suffix: string) => boolean;
	fold: (suffix: string, label: string) => JSX.Element;
}) {
	return (
		<Show when={props.source}>
			{(source) => (
				<>
					{props.fold(
						":source",
						props.phase === "Partial generated"
							? source().label.replace("Requested", "Partial")
							: props.phase === "Live slot"
								? source().label.replace("Requested", "Live slot")
								: source().label,
					)}
					<Show when={props.open(":source")}>
						<text fg={color("textMuted")} wrapMode="word">
							{props.phase === "Partial generated"
								? "Partial generated source — not an execution observation."
								: props.phase === "Live slot"
									? "Supplied current-round source — no retained intent linked; not proof of completion."
									: "Retained requested source — not proof of execution or completion."}
						</text>
						<SuppliedCode
							identity={`${props.phase}:${source().label}`}
							content={source().content}
							filetype={source().filetype}
							syntax={props.syntax}
						/>
					</Show>
				</>
			)}
		</Show>
	);
}
