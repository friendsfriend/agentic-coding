// Positive fixtures for resolution conventions: extensionless files and
// index.ts directory targets must resolve without diagnostics, and pure
// modules may import pure-safe builtins (node:path/node:crypto) but not I/O
// builtins.
import path from "node:path";
import type { Snapshot } from "../contracts";
import { catalog } from "../definitions";

export function resolution(input: string): string {
	return path.join(catalog[0], input);
}

export function typeOnly(snapshot: Snapshot): string {
	return snapshot.workflowId;
}