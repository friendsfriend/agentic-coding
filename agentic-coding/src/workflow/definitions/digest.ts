// Canonical JSON and the SHA-256 digest every workflow identity is built on.
// Kept in its own domain module so the registry, the custom-definition
// invariants and any other identity consumer share one canonicalization
// without importing each other (split-workflow-god-modules,
// persist-custom-workflow-definitions).
import { createHash } from "node:crypto";

function serializable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(serializable);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, serializable(entry)]),
		);
	return value;
}

export function stableJson(value: unknown): string {
	return JSON.stringify(serializable(value));
}

export function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}
