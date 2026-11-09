/** @jsxImportSource @opentui/solid */

import { For } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { color } from "../../ui/theme/index.ts";

/** One recognized supplied field. Labels describe the field the runtime recorded,
 * never a conclusion: no state here proves completion, adoption or approval. */
export type NativeField = { label: string; value: unknown };

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const present = (value: unknown) => value !== undefined && value !== null;

const pick = (source: Data, keys: readonly string[]): NativeField[] =>
	keys
		.filter((key) => present(source[key]))
		.map((key) => ({ label: key, value: source[key] }));

/** Tools whose supplied result is the one field worth naming at the top of the
 * card. Everything unrecognized keeps the generic retained-output composition. */
const known: Record<
	string,
	(argumentsObject: Data, result: Data) => NativeField[]
> = {
	request_review: (args, result) => [
		...pick(args, ["path", "title"]),
		...pick(result, [
			"id",
			"state",
			"digest",
			"revision",
			"comments",
			"createdAt",
		]),
	],
	attach_image: (args, result) => [
		...pick(args, ["path", "caption"]),
		...pick(result, ["id", "mediaType", "filename"]),
	],
	attach_evidence: (args, result) => [
		...pick(args, ["kind", "path", "caption"]),
		...pick(result, ["id", "mediaType", "filename"]),
	],
	start_task: (args, result) => [
		...pick(args, ["topic", "profile", "baseRef", "workspaceMode"]),
		...pick(result, ["taskId", "state", "conversationId"]),
	],
	task_result: (args, result) => [
		...pick(args, ["taskId"]),
		...pick(result, ["id", "state", "status", "conversationId"]),
	],
	cancel_task: (args, result) => [
		...pick(args, ["taskId"]),
		...pick(result, ["id", "state", "cancelled", "reason"]),
	],
	environment_action: (args, result) => [
		...pick(args, ["apps", "action", "target", "profile", "runtime"]),
		...pick(result, ["taskId", "state"]),
	],
	env_start: (args, result) => [
		...pick(args, ["apps", "app", "target", "profile", "runtime"]),
		...pick(result, ["state", "status", "apps", "endpoints"]),
	],
	env_status: (args, result) => [
		...pick(args, ["app"]),
		...pick(result, ["state", "status", "holder", "waiting", "run"]),
	],
	env_stop: (args, result) => [
		...pick(args, ["app"]),
		...pick(result, ["stopped", "state"]),
	],
};

export function nativeFields(
	name: string,
	argumentsValue: unknown,
	resultValue: unknown,
): NativeField[] | null {
	const adapter = known[name];
	if (!adapter) return null;
	const fields = adapter(object(argumentsValue), object(resultValue)).filter(
		(field) => typeof field.value !== "bigint",
	);
	return fields.length > 0 ? fields : null;
}

const rendered = (value: unknown): string =>
	typeof value === "string"
		? value
		: Array.isArray(value)
			? value.map((item) => rendered(item)).join(", ")
			: (JSON.stringify(value) ?? String(value));

/** Bounded disclosed rendering: long values are clipped here and stay complete
 * under Arguments/Details/Output, so nothing is silently summarized. */
export function ToolNativeFields(props: { rows: readonly NativeField[] }) {
	return (
		<box flexDirection="column">
			<text fg={color("textMuted")} wrapMode="word">
				Named fields are supplied runtime values for this card only — not
				current child status, completion, approval, adoption or a linked
				transcript.
			</text>
			<For each={props.rows}>
				{(row) => {
					const value = rendered(row.value);
					return (
						<text fg={color("textSecondary")} wrapMode="word">
							{`${row.label}: ${
								value.length > 400
									? `${value.slice(0, 400)}… (clipped; complete value under Arguments/Details/Output)`
									: value
							}`}
						</text>
					);
				}}
			</For>
		</box>
	);
}
