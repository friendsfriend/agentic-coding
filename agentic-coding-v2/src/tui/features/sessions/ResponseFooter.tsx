/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { Stamp } from "../../presentation/components/Stamp.tsx";
import {
	formatCost,
	formatTokenCount,
} from "../../presentation/components/transcriptFormat.ts";
import { color } from "../../ui/theme/index.ts";

const fields = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const usable = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** `"provider/model"`, in one quote pair and bounded like any supplied label. */
const modelName = (message: Data) => {
	const provider = typeof message.provider === "string" ? message.provider : "",
		model = typeof message.model === "string" ? message.model : "",
		name = [provider, model].filter((part) => part.length > 0).join("/");
	if (!name) return "not supplied";
	const points = Array.from(JSON.stringify(name));
	return points.length > 100
		? `${points.slice(0, 100).join("")}…`
		: points.join("");
};

/** Original right-edge recorded stamp/footer composition. Request start and
 * monotonic recorded duration only; no ticking, inferred finish or speed. */
export function ResponseFooter(props: { message: Data }) {
	// The one-line summary the developer reads: model, then only the accounting
	// that was actually supplied. Reasoning is a subset of output and cacheWrite1h
	// a subset of cacheWrite, so neither is added again; nothing is estimated.
	const summary = createMemo(() => {
		const usage = fields(props.message.usage),
			segments: string[] = [];
		if (usable(fields(usage.cost).total))
			segments.push(formatCost(Number(fields(usage.cost).total)));
		if (usable(usage.input) || usable(usage.output))
			segments.push(
				`${usable(usage.input) ? formatTokenCount(Number(usage.input)) : "—"}→${
					usable(usage.output) ? formatTokenCount(Number(usage.output)) : "—"
				} tok`,
			);
		return segments;
	});
	return (
		<box flexDirection="column" paddingLeft={3} paddingRight={1} flexShrink={0}>
			<box flexDirection="row">
				<text fg={color("textMuted")} flexGrow={1} wrapMode="word">
					{`${modelName(props.message)}${summary()
						.map((segment) => ` · ${segment}`)
						.join("")}`}
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
		</box>
	);
}
