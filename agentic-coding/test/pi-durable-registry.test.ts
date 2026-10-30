import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	bindDurableSession,
	createDurableSession,
	deleteDurableSession,
	durableSessionRegistryFile,
	initializeDurableSessions,
	readDurableSessionRegistry,
	requireDurableSession,
	selectDurableSession,
	updateDurableSessionRegistry,
} from "../src/pi-durable-registry.ts";
import { savePiDurableSessionName } from "../src/pi-durable-state.ts";

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});
function root() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
	roots.push(dir);
	return dir;
}
const owner = "uid:synthetic";
describe("durable session registry", () => {
	test("unsafe metadata symlinks, permissions, hardlinks and oversized files fail closed", () => {
		const dir = root();
		initializeDurableSessions(dir, dir, owner);
		const file = durableSessionRegistryFile(dir),
			original = fs.readFileSync(file, "utf8");
		fs.chmodSync(file, 0o644);
		expect(() => readDurableSessionRegistry(dir)).toThrow();
		fs.chmodSync(file, 0o600);
		const link = path.join(dir, "hardlink");
		fs.linkSync(file, link);
		expect(() => readDurableSessionRegistry(dir)).toThrow();
		fs.unlinkSync(link);
		const saved = path.join(dir, "saved");
		fs.renameSync(file, saved);
		fs.symlinkSync(saved, file);
		expect(() => readDurableSessionRegistry(dir)).toThrow();
		expect(fs.readFileSync(saved, "utf8")).toBe(original);
		fs.unlinkSync(file);
		fs.renameSync(saved, file);
		fs.writeFileSync(file, "x".repeat(2_000_001));
		expect(() => readDurableSessionRegistry(dir)).toThrow();
	});
	test("duplicate run/native identity and changed host-binding creation retry are rejected", () => {
		const dir = root();
		initializeDurableSessions(dir, dir, owner);
		const input = {
			operationId: "bound",
			owner,
			name: "Bound",
			cwd: dir,
			gitlabToolHost: "gitlab.example.invalid",
		};
		const record = createDurableSession(dir, input);
		bindDurableSession(dir, record.id, owner, {
			hostId: "host",
			conversationId: "native",
		});
		expect(() =>
			createDurableSession(dir, {
				...input,
				gitlabToolHost: "other.example.invalid",
			}),
		).toThrow("different settings");
		const registry = readDurableSessionRegistry(dir);
		if (!registry) throw new Error("fixture missing");
		const bound = requireDurableSession(registry, record.id, owner),
			duplicate = { ...bound, id: "duplicate", operationId: "duplicate" };
		fs.writeFileSync(
			durableSessionRegistryFile(dir),
			JSON.stringify({
				...registry,
				sessions: [...registry.sessions, duplicate],
			}),
		);
		expect(() => readDurableSessionRegistry(dir)).toThrow();
		fs.writeFileSync(
			durableSessionRegistryFile(dir),
			JSON.stringify({
				...registry,
				sessions: [
					...registry.sessions,
					{ ...duplicate, runId: "pi-durable-other" },
				],
			}),
		);
		expect(() => readDurableSessionRegistry(dir)).toThrow();
	});
	test("adopts legacy metadata without replacing it or native history", () => {
		const dir = root();
		savePiDurableSessionName(dir, "pi-durable-old");
		fs.writeFileSync(path.join(dir, "native-history"), "preserve me");
		const first = initializeDurableSessions(dir, dir, owner);
		expect(first.sessions[0]?.runId).toBe("pi-durable-old");
		expect(initializeDurableSessions(dir, "/other", owner)).toEqual(first);
		expect(fs.readFileSync(path.join(dir, "session.json"), "utf8")).toBe(
			'{"name":"pi-durable-old"}',
		);
		expect(fs.readFileSync(path.join(dir, "native-history"), "utf8")).toBe(
			"preserve me",
		);
	});
	test("creation retries are exact and background creates never steal selection", () => {
		const dir = root();
		const first = initializeDurableSessions(dir, dir, owner);
		const input = {
			operationId: "create-digest",
			owner,
			name: "Daily task digest",
			cwd: dir,
			model: "fake/model",
		};
		const record = createDurableSession(dir, input);
		expect(createDurableSession(dir, input)).toEqual(record);
		expect(readDurableSessionRegistry(dir)?.activeId).toBe(first.activeId);
		expect(() =>
			createDurableSession(dir, { ...input, cwd: "/other" }),
		).toThrow("different settings");
		selectDurableSession(dir, record.id, owner);
		expect(readDurableSessionRegistry(dir)?.activeId).toBe(record.id);
		expect(readDurableSessionRegistry(dir)?.sessions).toHaveLength(2);
	});
	test("native binding and pinned defaults survive reload; replacement fails closed", () => {
		const dir = root();
		initializeDurableSessions(dir, dir, owner);
		const record = createDurableSession(dir, {
			operationId: "a",
			owner,
			name: "A",
			cwd: dir,
			model: "fake/model",
		});
		bindDurableSession(dir, record.id, owner, {
			hostId: "store",
			conversationId: "native",
		});
		const loaded = readDurableSessionRegistry(dir);
		if (!loaded) throw new Error("missing registry");
		expect(
			requireDurableSession(loaded, record.id, owner).binding?.conversationId,
		).toBe("native");
		expect(() =>
			bindDurableSession(dir, record.id, owner, {
				hostId: "replacement",
				conversationId: "native",
			}),
		).toThrow("binding changed");
		expect(() =>
			requireDurableSession(loaded, record.id, "uid:foreign"),
		).toThrow("custody denied");
	});
	test("deletion tombstones the exact identity without retargeting selection or reusing its creation receipt", () => {
		const dir = root();
		initializeDurableSessions(dir, dir, owner);
		const input = { operationId: "a", owner, name: "A", cwd: dir };
		const record = createDurableSession(dir, input);
		selectDurableSession(dir, record.id, owner);
		deleteDurableSession(dir, record.id, owner);
		expect(readDurableSessionRegistry(dir)?.activeId).toBeNull();
		expect(() => createDurableSession(dir, input)).toThrow(
			"deleted or unavailable",
		);
		expect(readDurableSessionRegistry(dir)?.sessions).toHaveLength(2);
	});
	test("future/corrupt registries are never overwritten and orphan temporary writes are ignored", () => {
		const dir = root();
		const first = initializeDurableSessions(dir, dir, owner);
		fs.writeFileSync(
			`${durableSessionRegistryFile(dir)}.interrupted.tmp`,
			"{broken",
		);
		expect(readDurableSessionRegistry(dir)).toEqual(first);
		const future = JSON.stringify({ ...first, version: 99 });
		fs.writeFileSync(durableSessionRegistryFile(dir), future);
		expect(() => initializeDurableSessions(dir, dir, owner)).toThrow(
			"Unsupported or corrupt",
		);
		expect(fs.readFileSync(durableSessionRegistryFile(dir), "utf8")).toBe(
			future,
		);
	});
	test("concurrent metadata writer is denied rather than overwritten", () => {
		const dir = root();
		const initial = initializeDurableSessions(dir, dir, owner);
		updateDurableSessionRegistry(dir, (registry) => {
			expect(() => initializeDurableSessions(dir, dir, owner)).toThrow(
				"locked",
			);
			return { registry: registry ?? initial, result: undefined };
		});
		// The persistent lock inode is harmless after close/process exit.
		expect(initializeDurableSessions(dir, dir, owner)).toEqual(initial);
	});
});
