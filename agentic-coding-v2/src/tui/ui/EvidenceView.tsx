/** @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import type { EvidenceDocument } from "../../protocol/evidence.ts";
import { ActionHeader } from "./ActionHeader.tsx";
import { ImageView } from "./ImageView.tsx";
import { color } from "./theme/index.ts";
/** Explicit byte windows only. No player, extractor, path opener or network client. */
export function EvidenceView(props: {
	document: EvidenceDocument;
	syntax: SyntaxStyle;
	prepare: (command: string) => void;
}) {
	const decoded = createMemo(() => {
		try {
			const bytes = Uint8Array.from(atob(props.document.content), (value) =>
				value.charCodeAt(0),
			);
			if (bytes.length > 384000)
				throw new Error("Evidence byte window oversized");
			const textual = [
				"text/plain",
				"text/markdown",
				"application/json",
			].includes(props.document.mediaType);
			const text = textual
				? new TextDecoder("utf-8").decode(bytes)
				: [...bytes.subarray(0, 256)]
						.map((value) => value.toString(16).padStart(2, "0"))
						.join(" ");
			return {
				text: text.slice(0, 64000),
				clipped: text.length > 64000 || (!textual && bytes.length > 256),
				textual,
				error: null,
			};
		} catch (error) {
			return {
				text: "",
				clipped: false,
				textual: false,
				error:
					error instanceof Error ? error.message : "Evidence decode refused",
			};
		}
	});
	return (
		<box flexDirection="column" gap={1}>
			<text wrapMode="word" fg={color("textMuted")}>
				{props.document.caption} · {props.document.mediaType} · bytes [
				{props.document.offset},{" "}
				{Math.min(props.document.offset + 384000, props.document.totalBytes)})
				of {props.document.totalBytes}. Entire retained file digest/owner
				verified by native boundary; a byte window is not completeness or
				independent process evidence.
			</text>
			<Show
				when={props.document.mediaType.startsWith("image/")}
				fallback={
					<>
						<text wrapMode="word" fg={color("warning")}>
							{decoded().textual
								? "Literal inert UTF-8 source; chunk-boundary characters may display as replacement glyphs. Report links/HTML/scripts are never activated or executed."
								: "Binary signature and bytes only. Terminal does not execute scripts, extract ZIP traces or play video. Inspect a separately retained task-owned poster for pixels; metadata/hex is not visual or trace-analysis proof."}{" "}
							{decoded().clipped
								? "Display clipped to 64,000 text characters or 256 binary bytes; original byte identity remains unchanged."
								: ""}
						</text>
						<code
							content={decoded().text}
							filetype={
								props.document.mediaType === "application/json"
									? "json"
									: "text"
							}
							syntaxStyle={props.syntax}
							drawUnstyledText={true}
							wrapMode="word"
						/>
					</>
				}
			>
				<ImageView
					content={props.document.content}
					mediaType={props.document.mediaType}
					caption={props.document.caption}
				/>
			</Show>
			<Show when={decoded().error}>
				<text fg={color("warning")}>{decoded().error}</text>
			</Show>
			<Show when={props.document.offset > 0}>
				<ActionHeader
					onActivate={() =>
						props.prepare(
							`/evidence ${props.document.taskId} ${props.document.id} ${Math.max(0, props.document.offset - 384000)}`,
						)
					}
				>
					<text fg={color("accent")}>
						Prepare previous retained byte window (explicit submission)
					</text>
				</ActionHeader>
			</Show>
			<Show when={props.document.nextOffset !== null}>
				<ActionHeader
					onActivate={() =>
						props.prepare(
							`/evidence ${props.document.taskId} ${props.document.id} ${props.document.nextOffset}`,
						)
					}
				>
					<text fg={color("accent")}>
						Prepare next retained byte window (explicit submission)
					</text>
				</ActionHeader>
			</Show>
		</box>
	);
}
