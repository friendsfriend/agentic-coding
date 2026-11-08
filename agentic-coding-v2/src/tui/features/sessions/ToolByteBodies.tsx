/** @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { Show } from "solid-js";
import { color } from "../../ui/theme/index.ts";
import { FileContent } from "./FileContent.tsx";

/** UI bytes and owner-proven line position only. No native result or file handle. */
export function ToolReadBody(props: {
	path: string;
	file: string | null;
	notice: string | null;
	startLine: number;
	failed: boolean;
	output: string;
	syntax: SyntaxStyle;
}) {
	return (
		<Show
			when={!props.failed}
			fallback={
				<text fg={color("error")} wrapMode="word">
					{props.output}
				</text>
			}
		>
			<Show when={props.file !== null}>
				<FileContent
					path={props.path}
					content={props.file ?? ""}
					syntax={props.syntax}
					startLine={props.startLine}
					label="Retained read output — not a live file snapshot"
				/>
			</Show>
			<Show when={props.notice !== null}>
				<text fg={color("textMuted")} wrapMode="word">
					{props.file === null
						? "Retained read text · file-line provenance unavailable; possible SDK annotation kept verbatim"
						: "Retained SDK-style read annotation · metadata-matched, not a file line"}
				</text>
				<text fg={color("text")} wrapMode="word">
					{props.notice ?? ""}
				</text>
			</Show>
		</Show>
	);
}

/** Unknown request values stay unknown; absence never becomes empty write bytes. */
export function ToolWriteBody(props: {
	path: string;
	content: unknown;
	partial?: boolean;
	liveOnly?: boolean;
	syntax: SyntaxStyle;
}) {
	return (
		<Show
			when={typeof props.content === "string"}
			fallback={
				<text fg={color("textMuted")} wrapMode="word">
					Write content unavailable as a supplied string. Complete Arguments
					remain below; no empty write is inferred.
				</text>
			}
		>
			<Show when={props.content === ""}>
				<text fg={color("textMuted")} wrapMode="word">
					Supplied write content is an explicit empty string — not proof of an
					applied write.
				</text>
			</Show>
			<FileContent
				path={props.path}
				content={typeof props.content === "string" ? props.content : ""}
				syntax={props.syntax}
				label={
					props.partial
						? "Partial requested write bytes — call still being generated"
						: props.liveOnly
							? "Supplied current-round write bytes — no retained intent linked; not a live file snapshot"
							: "Requested write bytes — not a live file snapshot"
				}
			/>
		</Show>
	);
}

/** Request presentation only. Shell-family admission and output stay with owner. */
export function ToolShellBody(props: {
	command: unknown;
	timeout: unknown;
	partial?: boolean;
	liveOnly?: boolean;
	syntax: SyntaxStyle;
}) {
	return (
		<>
			<text fg={color("textMuted")} wrapMode="word">
				{props.partial
					? "Partial generated shell command"
					: props.liveOnly
						? "Supplied current-round shell command"
						: "Requested shell command"}{" "}
				·{" "}
				{props.timeout === undefined
					? "timeout not supplied in observed arguments"
					: typeof props.timeout === "number" && Number.isFinite(props.timeout)
						? `supplied timeout ${props.timeout}`
						: "timeout unavailable as a supplied finite number; see Arguments"}
			</text>
			<Show
				when={typeof props.command === "string"}
				fallback={
					<text fg={color("textMuted")} wrapMode="word">
						Shell command unavailable as a supplied string; no empty command is
						inferred. Complete Arguments remain below.
					</text>
				}
			>
				<Show when={props.command === ""}>
					<text fg={color("textMuted")} wrapMode="word">
						Supplied shell command is an explicit empty string — not an
						execution observation.
					</text>
				</Show>
				<code
					content={typeof props.command === "string" ? props.command : ""}
					filetype="bash"
					syntaxStyle={props.syntax}
					drawUnstyledText={true}
					wrapMode="word"
				/>
			</Show>
		</>
	);
}
