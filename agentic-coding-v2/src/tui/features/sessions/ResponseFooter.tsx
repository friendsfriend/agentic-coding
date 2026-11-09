/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { Stamp } from "../../presentation/components/Stamp.tsx";
import {
	formatCost,
	formatTokenCount,
} from "../../presentation/components/transcriptFormat.ts";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { color } from "../../ui/theme/index.ts";

const fields = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const reported = (value: unknown, cost = false) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? cost
			? formatCost(value)
			: formatTokenCount(value)
		: "not supplied/usable";

const modelLabel = (value: unknown) => {
	if (typeof value !== "string") return "(not supplied)";
	const points = Array.from(JSON.stringify(value));
	return points.slice(0, 100).join("") + (points.length > 100 ? "…" : "");
};

/** A summary only. Reasoning is a subset of output and cacheWrite1h a subset
 * of cacheWrite: neither is added again. Exact supplied fields remain below. */
export function ReportedUsage(props: { usage: unknown; window?: boolean }) {
	const usage = () => fields(props.usage);
	const cost = () => (props.window ? usage().cost : fields(usage().cost).total);
	return (
		<text fg={color("textMuted")} wrapMode="word">
			{props.window
				? "History-window reported usage"
				: "Response reported usage"}{" "}
			· {reported(cost(), true)} · tok {reported(usage().input)}→
			{reported(usage().output)} · cache read {reported(usage().cacheRead)} ·
			cache write {reported(usage().cacheWrite)}
			<Show when={usage().reasoning !== undefined}>
				{" "}
				· reasoning {reported(usage().reasoning)} (included in output)
			</Show>
			<Show when={usage().cacheWrite1h !== undefined}>
				{" "}
				· 1h cache write {reported(usage().cacheWrite1h)} (included in cache
				write)
			</Show>
		</text>
	);
}

/** Original right-edge recorded stamp/footer composition. Request start and
 * monotonic recorded duration only; no ticking, inferred finish or speed. */
export function ResponseFooter(props: {
	message: Data;
	scope: unknown;
	interactive: boolean;
}) {
	const source = createMemo(() => ({
		scope: props.scope,
		message: props.message,
	}));
	const metadata = createMemo(() => {
		const message = props.message;
		return Object.fromEntries(
			[
				"api",
				"provider",
				"model",
				"responseModel",
				"responseId",
				"thinkingLevel",
				"providerThinkingLevel",
				"timestamp",
				"durationMs",
				"usage",
				"stopReason",
				"rawStopReason",
				"endTurn",
				"errorMessage",
				"diagnostics",
				"deferred",
			]
				.filter((key) => Object.hasOwn(message, key))
				.map((key) => [key, message[key]]),
		);
	});
	return (
		<box flexDirection="column" paddingLeft={3} paddingRight={1} flexShrink={0}>
			<box flexDirection="row">
				<text fg={color("textMuted")} flexGrow={1} wrapMode="word">
					Assistant · {modelLabel(props.message.provider)}/
					{modelLabel(props.message.model)} ·{" "}
					{props.message.nativePartial === true
						? "native committed partial"
						: "retained response"}
				</text>
				<Stamp
					timestamp={props.message.timestamp}
					durationMs={
						props.message.nativePartial === true ||
						props.message.stopReason === "pending"
							? undefined
							: props.message.durationMs
					}
					clockLabel="request"
				/>
			</box>
			<ReportedUsage usage={props.message.usage} />
			<SuppliedObservation
				interactive={props.interactive}
				scope={source()}
				label="Supplied response metadata, usage and recorded timing; not task completion evidence. Missing fields remain absent; reported zero is not proof of free billing"
				value={metadata()}
			/>
		</box>
	);
}
