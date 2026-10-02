import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiAuthCredentialStore } from "../src/agent-host/credentials.ts";

function tempAuthPath(initial?: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-"));
	const file = path.join(dir, "auth.json");
	if (initial) fs.writeFileSync(file, JSON.stringify(initial));
	return file;
}

describe("live global pi credentials", () => {
	test("reads an existing api_key credential without copying it anywhere", async () => {
		const authPath = tempAuthPath({
			anthropic: { type: "api_key", key: "sk-test" },
		});
		const store = new PiAuthCredentialStore(authPath);
		await expect(store.read("anthropic")).resolves.toEqual({
			type: "api_key",
			key: "sk-test",
		});
		await expect(store.read("openai")).resolves.toBeUndefined();
	});

	test("list exposes only non-secret metadata", async () => {
		const authPath = tempAuthPath({
			anthropic: { type: "api_key", key: "sk-test" },
			"github-copilot": {
				type: "oauth",
				refresh: "r",
				access: "a",
				expires: 1,
			},
		});
		const store = new PiAuthCredentialStore(authPath);
		const list = [...(await store.list())];
		expect(
			list.sort((a, b) => a.providerId.localeCompare(b.providerId)),
		).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "github-copilot", type: "oauth" },
		]);
		expect(JSON.stringify(list)).not.toContain("sk-test");
	});

	test("modify is a serialized read-modify-write against the same file pi itself uses", async () => {
		const authPath = tempAuthPath({
			anthropic: { type: "api_key", key: "sk-old" },
		});
		const store = new PiAuthCredentialStore(authPath);
		const updated = await store.modify("anthropic", async (current) => {
			expect(current).toEqual({ type: "api_key", key: "sk-old" });
			return { type: "api_key", key: "sk-new" };
		});
		expect(updated).toEqual({ type: "api_key", key: "sk-new" });
		const onDisk = JSON.parse(fs.readFileSync(authPath, "utf8"));
		expect(onDisk.anthropic).toEqual({ type: "api_key", key: "sk-new" });
	});

	test("concurrent modify calls serialize rather than lose a write", async () => {
		const authPath = tempAuthPath({});
		const store = new PiAuthCredentialStore(authPath);
		await Promise.all([
			store.modify("a", async () => ({ type: "api_key", key: "1" })),
			store.modify("b", async () => ({ type: "api_key", key: "2" })),
			store.modify("c", async () => ({ type: "api_key", key: "3" })),
		]);
		const onDisk = JSON.parse(fs.readFileSync(authPath, "utf8"));
		expect(Object.keys(onDisk).sort()).toEqual(["a", "b", "c"]);
	});

	test("delete removes a stored credential", async () => {
		const authPath = tempAuthPath({
			anthropic: { type: "api_key", key: "sk-test" },
		});
		const store = new PiAuthCredentialStore(authPath);
		await store.delete("anthropic");
		await expect(store.read("anthropic")).resolves.toBeUndefined();
	});

	test("an absent auth.json reads as no credentials rather than throwing", async () => {
		const store = new PiAuthCredentialStore(
			path.join(os.tmpdir(), `does-not-exist-${Date.now()}`, "auth.json"),
		);
		await expect(store.read("anthropic")).resolves.toBeUndefined();
		await expect(store.list()).resolves.toEqual([]);
	});
});
