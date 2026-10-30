// The Pi Durable session keeps its active conversation name next to its host,
// so a shell restart reopens the conversation the developer was working in.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	currentPiDurableSessionName,
	DEFAULT_PI_DURABLE_SESSION_NAME,
	piDurableRuntimeDir,
	piDurableSessionFile,
	savePiDurableSessionName,
} from "../src/pi-durable-state.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { force: true, recursive: true });
});
function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-durable-state-"));
	roots.push(root);
	return root;
}

describe("pi-durable session state", () => {
	test("lives under the configuration root in its own directory", () => {
		const root = temporaryRoot();
		expect(piDurableRuntimeDir(root)).toBe(path.join(root, "pi-durable"));
		expect(piDurableSessionFile(piDurableRuntimeDir(root))).toBe(
			path.join(root, "pi-durable", "session.json"),
		);
	});

	test("a broken legacy link is unknown, never a fresh install", () => {
		const runtimeDir = piDurableRuntimeDir(temporaryRoot());
		fs.mkdirSync(runtimeDir);
		fs.symlinkSync(
			path.join(runtimeDir, "missing-target"),
			piDurableSessionFile(runtimeDir),
		);
		expect(currentPiDurableSessionName(runtimeDir)).toBeUndefined();
	});
	test("a missing file is a fresh install and names the first session", () => {
		expect(
			currentPiDurableSessionName(piDurableRuntimeDir(temporaryRoot())),
		).toBe(DEFAULT_PI_DURABLE_SESSION_NAME);
	});

	test("persists and reads back a fresh session name", () => {
		const runtimeDir = piDurableRuntimeDir(temporaryRoot());
		savePiDurableSessionName(runtimeDir, "pi-durable-m3k2");
		expect(currentPiDurableSessionName(runtimeDir)).toBe("pi-durable-m3k2");
	});

	test("a filesystem failure is unknown rather than a fresh install", () => {
		const runtimeDir = piDurableRuntimeDir(temporaryRoot());
		fs.mkdirSync(runtimeDir, { recursive: true });
		const file = piDurableSessionFile(runtimeDir);
		// A self-referential link reliably produces ELOOP even when tests run
		// as an account that can bypass ordinary file permission checks.
		fs.symlinkSync(file, file);
		expect(currentPiDurableSessionName(runtimeDir)).toBeUndefined();
	});

	test("rejects foreign names before overwriting existing metadata", () => {
		const runtimeDir = piDurableRuntimeDir(temporaryRoot());
		savePiDurableSessionName(runtimeDir, "pi-durable-original");
		expect(() => savePiDurableSessionName(runtimeDir, "orchestrator")).toThrow(
			"Invalid pi-durable session name",
		);
		expect(currentPiDurableSessionName(runtimeDir)).toBe("pi-durable-original");
	});

	test("a malformed or foreign name reads as unknown, never as a guess", () => {
		const runtimeDir = piDurableRuntimeDir(temporaryRoot());
		fs.mkdirSync(runtimeDir, { recursive: true });
		const file = piDurableSessionFile(runtimeDir);
		fs.writeFileSync(file, "{ not json");
		expect(currentPiDurableSessionName(runtimeDir)).toBeUndefined();
		// Another mode's session name must not be adopted as this one.
		fs.writeFileSync(file, JSON.stringify({ name: "orchestrator" }));
		expect(currentPiDurableSessionName(runtimeDir)).toBeUndefined();
	});
});
