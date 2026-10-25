// The Pi Durable session keeps its active conversation name next to its host,
// so a shell restart reopens the conversation the developer was working in.
import { describe, expect, test } from "bun:test";
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

function temporaryRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-durable-state-"));
}

describe("pi-durable session state", () => {
	test("lives under the configuration root in its own directory", () => {
		const root = temporaryRoot();
		expect(piDurableRuntimeDir(root)).toBe(path.join(root, "pi-durable"));
		expect(piDurableSessionFile(piDurableRuntimeDir(root))).toBe(
			path.join(root, "pi-durable", "session.json"),
		);
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
