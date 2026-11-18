import type { Data } from "../../../protocol/index.ts";

export const fields = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
export const usable = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One input's exchange: every assistant response admitted after the same user
 * message, summarised once. Recorded values only; nothing is estimated. */
export type TurnStats = {
	/** The group's last assistant record, for the recorded request stamp. */
	last: Data;
	/** Distinct `provider/model` identities in first-seen order. */
	models: string[];
	cost?: number;
	input?: number;
	output?: number;
	responses: number;
};

/** Recorded output tokens per second for one *completed* generation: that
 * message's own output over its own recorded duration, to one decimal, as the
 * original transcript reported it. A streaming partial and a message whose duration
 * was never recorded report nothing rather than a rate the source does
 * not know. */
export function generationSpeed(message: Data | undefined): number | undefined {
	if (!message) return undefined;
	const output = fields(message.usage).output;
	const duration = message.durationMs;
	if (!usable(output) || output <= 0) return undefined;
	if (
		typeof duration !== "number" ||
		!Number.isFinite(duration) ||
		duration <= 0
	)
		return undefined;
	return Math.round((output / (duration / 1000)) * 10) / 10;
}

const modelName = (message: Data) => {
	const provider = typeof message.provider === "string" ? message.provider : "",
		model = typeof message.model === "string" ? message.model : "";
	return [provider, model].filter((part) => part.length > 0).join("/");
};

/** `"provider/model"`, in one quote pair and bounded like any supplied label.
 * A group answered by more than one model names each of them. */
export const modelLabel = (models: string[]) => {
	const name = models.length > 0 ? models.join(", ") : "";
	if (!name) return "not supplied";
	const points = Array.from(JSON.stringify(name));
	return points.length > 100
		? `${points.slice(0, 100).join("")}…`
		: points.join("");
};

/** Group rendered messages by input: a `user` message opens a group, every
 * following assistant response belongs to it, and the group's summary is carried
 * by the group's last rendered message so it reads as one footer per input. */
export function turnStats(messages: Data[]): Map<string, TurnStats> {
	const stats = new Map<string, TurnStats>();
	let current: TurnStats | null = null,
		carrier: string | null = null;
	const flush = () => {
		if (current && carrier !== null) stats.set(carrier, current);
		current = null;
		carrier = null;
	};
	for (const message of messages) {
		const identity = String(message.identity);
		if (message.role === "user") {
			flush();
			continue;
		}
		if (message.role === "assistant") {
			const usage = fields(message.usage),
				cost = fields(usage.cost).total,
				name = modelName(message);
			if (!current) current = { last: message, models: [], responses: 0 };
			current.last = message;
			current.responses += 1;
			if (name && !current.models.includes(name)) current.models.push(name);
			if (usable(cost)) current.cost = (current.cost ?? 0) + cost;
			if (usable(usage.input))
				current.input = (current.input ?? 0) + usage.input;
			if (usable(usage.output))
				current.output = (current.output ?? 0) + usage.output;
		}
		// A group's summary is carried by the last rendered message it produced,
		// so a trailing tool result does not leave the footer above it.
		if (current) carrier = identity;
	}
	flush();
	return stats;
}

/** Provider failures live on the envelope, including when content is empty. */
export function assistantFailure(message: Data): string | null {
	if (
		message.role !== "assistant" ||
		!["error", "aborted"].includes(String(message.stopReason))
	)
		return null;
	if (typeof message.errorMessage === "string" && message.errorMessage.trim())
		return message.errorMessage;
	return message.stopReason === "aborted"
		? "Response aborted"
		: "Model request failed without an error message";
}
