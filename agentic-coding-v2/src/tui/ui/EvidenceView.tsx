/** @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { createMemo, onCleanup, Show } from "solid-js";
import type { EvidenceDocument } from "../../protocol/evidence.ts";
import { evidenceMediaTypes } from "../../protocol/evidence.ts";
import { SuppliedCode } from "../features/sessions/SuppliedCode.tsx";
import { ActionHeader } from "./ActionHeader.tsx";
import { ImageView } from "./ImageView.tsx";
import { color } from "./theme/index.ts";
/** One explicit native byte window. Local text ranges retain the WHOLE decoded
 * window; they never skip native bytes, fetch a next page or open paths/URLs. */
export function EvidenceView(props: {
	document: EvidenceDocument;
	syntax: SyntaxStyle;
	prepare: (command: string) => void;
}) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const source = createMemo(() => props.document);
	const decoded = createMemo(() => {
		const document = source();
		try {
			if (
				!Number.isSafeInteger(document.taskId) ||
				document.taskId <= 0 ||
				!/^[a-f0-9]{64}$/.test(document.id) ||
				!Number.isSafeInteger(document.offset) ||
				document.offset < 0 ||
				!Number.isSafeInteger(document.totalBytes) ||
				document.totalBytes < document.offset ||
				!evidenceMediaTypes.some((type) => type === document.mediaType) ||
				typeof document.content !== "string" ||
				document.content.length > 512000
			)
				throw new Error(
					"Evidence descriptor owner, identity, offset or media type refused",
				);
			const bytes = Uint8Array.from(atob(document.content), (value) =>
				value.charCodeAt(0),
			);
			if (
				bytes.length !==
					Math.min(384000, document.totalBytes - document.offset) ||
				(document.nextOffset === null &&
					document.offset + bytes.length !== document.totalBytes) ||
				(document.mediaType.startsWith("image/") &&
					(document.offset !== 0 || document.nextOffset !== null)) ||
				(document.nextOffset !== null &&
					(!Number.isSafeInteger(document.nextOffset) ||
						document.nextOffset !== document.offset + bytes.length ||
						document.nextOffset <= document.offset ||
						document.nextOffset >= document.totalBytes))
			)
				throw new Error("Evidence byte-window boundary refused");
			const textual = [
				"text/plain",
				"text/markdown",
				"application/json",
			].includes(document.mediaType);
			const text = textual
				? new TextDecoder("utf-8").decode(bytes)
				: [...bytes.subarray(0, 256)]
						.map((value) => value.toString(16).padStart(2, "0"))
						.join(" ");
			return {
				text,
				clipped: !textual && bytes.length > 256,
				textual,
				bytes: bytes.length,
				error: null,
			};
		} catch (error) {
			return {
				text: "",
				clipped: false,
				textual: false,
				bytes: 0,
				error:
					error instanceof Error ? error.message : "Evidence decode refused",
			};
		}
	});
	return (
		<Show when={source()} keyed>
			{(saved) => {
				const active = () =>
					!disposed && source() === saved && decoded().error === null;
				return (
					<box flexDirection="column" gap={1}>
						<text wrapMode="word" fg={color("textMuted")}>
							{saved.caption} · {saved.mediaType} · supplied bytes [
							{saved.offset}, {saved.offset + decoded().bytes}) of{" "}
							{saved.totalBytes}. Native boundary reports entire retained
							digest/owner verification; this view does not independently verify
							the original file or process. A byte window is not completeness or
							visual proof.
						</text>
						<Show when={decoded().error}>
							<text fg={color("warning")}>{decoded().error}</text>
						</Show>
						<Show when={active()}>
							<Show
								when={saved.mediaType.startsWith("image/")}
								fallback={
									<box flexDirection="column" gap={1}>
										<text wrapMode="word" fg={color("warning")}>
											{decoded().textual
												? "Literal inert UTF-8 decode of the entire supplied byte window. Chunk-boundary characters may be replacement glyphs; local body lines/UTF-16 positions are NOT original file lines or byte offsets. Report links, HTML and scripts never activate. All decoded text remains available through local source windows."
												: "Binary signature only; scripts are not executed, ZIP traces are not extracted and videos are not played. Separately retained task-owned posters provide pixels; metadata/hex is not visual or trace-analysis proof."}
											{decoded().clipped
												? " Binary display bounded to the first 256 supplied bytes; no omitted bytes are claimed inspected."
												: ""}
										</text>
										<SuppliedCode
											content={decoded().text}
											identity={`evidence:${saved.taskId}:${saved.id}:${saved.offset}`}
											filetype={
												saved.mediaType === "application/json" ? "json" : "text"
											}
											syntax={props.syntax}
										/>
									</box>
								}
							>
								<ImageView
									content={saved.content}
									mediaType={saved.mediaType}
									caption={saved.caption}
								/>
							</Show>
							<Show when={saved.offset > 0}>
								<ActionHeader
									scope={saved}
									interactive={active()}
									onActivate={() => {
										if (active())
											props.prepare(
												`/evidence ${saved.taskId} ${saved.id} ${Math.max(0, saved.offset - 384000)}`,
											);
									}}
								>
									<text fg={color("accent")}>
										Prepare previous native retained byte window (explicit
										submission)
									</text>
								</ActionHeader>
							</Show>
							<Show when={saved.nextOffset !== null}>
								<ActionHeader
									scope={saved}
									interactive={active()}
									onActivate={() => {
										if (active())
											props.prepare(
												`/evidence ${saved.taskId} ${saved.id} ${saved.nextOffset}`,
											);
									}}
								>
									<text fg={color("accent")}>
										Prepare next native retained byte window (explicit
										submission; not local text paging)
									</text>
								</ActionHeader>
							</Show>
						</Show>
					</box>
				);
			}}
		</Show>
	);
}
