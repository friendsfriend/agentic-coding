/** @jsxImportSource @opentui/solid */
import { createHash } from "node:crypto";
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, onCleanup, Show } from "solid-js";
import { SuppliedCode } from "../features/sessions/SuppliedCode.tsx";
import { color } from "./theme/index.ts";

/** Exact supplied text, or explicitly serialized supplied JSON fields. Bounded
 * source windows never imply original file bytes or an approval digest. */
export function SuppliedObservation(props: {
	value: unknown;
	label: string;
	scope: unknown;
}) {
	const syntax = SyntaxStyle.fromStyles(
		{
			default: { fg: color("text") },
			"markup.heading": { fg: color("primary"), bold: true },
		},
		useRenderer().nativeScene,
	);
	onCleanup(() => syntax.destroy());
	let generation = 0;
	const supplied = createMemo(() => ({
		value: props.value,
		scope: props.scope,
		generation: ++generation,
	}));
	const body = createMemo(() =>
		typeof supplied().value === "string"
			? String(supplied().value)
			: (JSON.stringify(supplied().value, null, 2) ?? ""),
	);
	const key = createMemo(
		() =>
			`observation:${supplied().generation}:${createHash("sha256").update(body()).digest("hex")}`,
	);
	return (
		<Show
			when={supplied().value !== undefined}
			fallback={
				<text fg={color("textMuted")}>
					{props.label}: not supplied (distinct from null or empty).
				</text>
			}
		>
			<box
				flexDirection="column"
				gap={1}
				paddingLeft={1}
				border={["left"]}
				borderColor={color("border")}
			>
				<text fg={color("textMuted")}>
					{props.label} ·{" "}
					{typeof supplied().value === "string"
						? "supplied text"
						: "serialized supplied JSON fields; not original source bytes"}
				</text>
				<Show when={key()} keyed>
					{(identity) => (
						<SuppliedCode
							content={body()}
							filetype={typeof supplied().value === "string" ? "text" : "json"}
							syntax={syntax}
							identity={identity}
						/>
					)}
				</Show>
			</box>
		</Show>
	);
}
