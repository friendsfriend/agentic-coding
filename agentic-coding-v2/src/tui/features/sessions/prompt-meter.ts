import type { Data } from "../../../protocol/index.ts";
import {
	formatCost,
	formatTokenCount,
} from "../../presentation/components/transcriptFormat.ts";
import { fields, usable } from "./turn-stats.ts";

/** Prompt tokens of the newest generation: the active context size the original
 * prompt footer reported, as the sum of the input the request sent and the cache
 * reads/writes it reused. Committed entries only — a live partial carries no
 * usage — and nothing is inferred when no entry reports one. */
export function activeContextTokens(entries: Data[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = fields(entries[index]);
		const messages = Array.isArray(entry.model) ? entry.model : [];
		for (let position = messages.length - 1; position >= 0; position -= 1) {
			const message = fields(messages[position]);
			if (message.role !== "assistant") continue;
			const usage = fields(message.usage);
			const total =
				(usable(usage.input) ? usage.input : 0) +
				(usable(usage.cacheRead) ? usage.cacheRead : 0) +
				(usable(usage.cacheWrite) ? usage.cacheWrite : 0);
			if (total > 0) return total;
		}
	}
	return undefined;
}

/** The original prompt footer, in its original order: the active context size and
 * the fraction of the model's window it occupies, the recorded cost of the
 * returned history window, then that window's recorded input→output tokens. A
 * window the catalogue does not supply omits the percentage rather than
 * inventing one, and an absent context reports no meter at all. */
export function promptMeter(values: {
	contextTokens?: number;
	contextWindow?: number | null;
	cost?: number;
	input?: number;
	output?: number;
}): string {
	const parts: string[] = [];
	if (values.contextTokens !== undefined) {
		const window = values.contextWindow;
		const percent =
			typeof window === "number" && Number.isFinite(window) && window > 0
				? ` (${Math.round((values.contextTokens / window) * 100)}%)`
				: "";
		parts.push(`${formatTokenCount(values.contextTokens)}${percent}`);
	}
	if (usable(values.cost)) parts.push(formatCost(values.cost));
	if (usable(values.input) || usable(values.output))
		parts.push(
			`tok ${formatTokenCount(usable(values.input) ? values.input : 0)}→${formatTokenCount(usable(values.output) ? values.output : 0)}`,
		);
	return parts.join(" · ");
}
