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

test("compiled durable models derive and refresh Codex OAuth without node_modules", async () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "agent-host-compiled-oauth-"),
	);
	try {
		const authPath = path.join(dir, "auth.json");
		const credential = {
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 3_600_000,
		};
		fs.writeFileSync(authPath, JSON.stringify({ "openai-codex": credential }), {
			mode: 0o600,
		});
		const entrypoint = path.join(dir, "oauth.ts");
		fs.writeFileSync(
			entrypoint,
			`
import { builtinModels } from ${JSON.stringify(Bun.resolveSync("@earendil-works/pi-ai/providers/all", import.meta.dir))};
import { PiAuthCredentialStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/agent-host/credentials.ts"))};
import { withDurableSession } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/agent-host/host.ts"))};
const store = new PiAuthCredentialStore(process.argv[2]);
const models = withDurableSession(builtinModels({ credentials: store }));
const valid = await models.getAuth("openai-codex");
await store.modify("openai-codex", async (credential) => ({ ...credential, expires: 0 }));
const payload = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }));
const access = "header." + payload + ".signature";
let refreshes = 0;
globalThis.fetch = async (url, options) => {
	if (String(url) !== "https://auth.openai.com/oauth/token" ||
		new URLSearchParams(options?.body).get("refresh_token") !== "test-refresh")
		throw new Error("Unexpected OAuth request");
	refreshes++;
	return Response.json({ access_token: access, refresh_token: "rotated-refresh", expires_in: 3600 });
};
const refreshed = await models.getAuth("openai-codex");
console.log(JSON.stringify({ valid, refreshed, access, refreshes }));
`,
		);
		const binary = path.join(dir, "oauth");
		const build = await Bun.build({
			entrypoints: [entrypoint],
			compile: {
				outfile: binary,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
		});
		expect(build.success).toBe(true);
		const child = Bun.spawn([binary, authPath], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.valid).toEqual({
			auth: { apiKey: credential.access },
			source: "OAuth",
		});
		expect(result.refreshed).toEqual({
			auth: { apiKey: result.access },
			source: "OAuth",
		});
		expect(result.refreshes).toBe(1);
		const stored = await new PiAuthCredentialStore(authPath).read(
			"openai-codex",
		);
		expect(stored).toMatchObject({
			access: result.access,
			refresh: "rotated-refresh",
			accountId: "test-account",
		});
		expect(stored?.type === "oauth" && stored.expires > Date.now()).toBe(true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);
