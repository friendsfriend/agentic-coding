import type { JsonValue } from "@earendil-works/chord";

/** Keep an action envelope valid when its log reaches the tool's total bound.
 * Escape expansion counts too; metadata and the truncation flag are retained. */
export function boundedToolLog(value: unknown, maxChars: number): unknown {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("output" in value) ||
		typeof value.output !== "string"
	)
		return value;
	if (JSON.stringify(value).length <= maxChars) return value;
	const base = { ...value, output: "", truncated: true };
	const room = maxChars - JSON.stringify(base).length;
	if (room <= 0) return value;
	const points = Array.from(value.output);
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (JSON.stringify(points.slice(0, mid).join("")).length - 2 <= room)
			low = mid;
		else high = mid - 1;
	}
	return { ...base, output: points.slice(0, low).join("") };
}

/** Carry the same bounded, already-redacted result to the UI without asking it
 * to parse model-facing prose. Never bypass a tool's output size limit. */
export function toolViewDetails(
	value: unknown,
	maxChars: number,
): { view: JsonValue } | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const json = JSON.stringify(value);
	if (!json || json.length > maxChars) return undefined;
	return { view: JSON.parse(json) as JsonValue };
}
