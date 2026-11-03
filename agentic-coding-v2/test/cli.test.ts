import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [],
	children: Bun.Subprocess[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
test("isolated CLI boots with separate config/state, authenticates its API, excludes another host and rotates authority after graceful reopen", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-cli-"));
	roots.push(root);
	const configDir = path.join(root, "configuration"),
		stateDir = path.join(root, "state"),
		agentDir = path.join(root, "empty-agent");
	fs.mkdirSync(configDir);
	fs.mkdirSync(agentDir);
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({
			profiles: {
				offline: { model: "anthropic/claude-sonnet-4-5", thinking: "off" },
			},
			orchestratorProfile: "offline",
			repositories: [root],
		}),
	);
	// Empty HOME/auth and an explicit environment whitelist: no host credentials,
	// model prompts, tasks, schedules, existing apps or external infrastructure.
	const spawn = () => {
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "../src/cli.ts"),
				"--config-dir",
				configDir,
				"--state-dir",
				stateDir,
				"--port",
				"0",
			],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					PI_CODING_AGENT_DIR: agentDir,
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		children.push(child);
		return child;
	};
	const boot = async () => {
		const child = spawn(),
			errors = new Response(child.stderr).text(),
			reader = child.stdout.getReader();
		const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
		let output = "",
			handedOff = false;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done)
					throw new Error(
						"Disposable CLI exited before publishing its private URL",
					);
				output += new TextDecoder().decode(chunk.value);
				if (output.length > 64000)
					throw new Error("Disposable CLI startup exceeded its output bound");
				const line = output
					.split("\n")
					.slice(0, -1)
					.find(
						(line) =>
							line.startsWith("http://127.0.0.1:") && line.includes("/#token="),
					);
				if (!line) continue;
				const url = new URL(line),
					token = new URLSearchParams(url.hash.slice(1)).get("token");
				if (!token)
					throw new Error("Disposable CLI omitted its authentication token");
				const drained = (async () => {
					try {
						while (!(await reader.read()).done) {}
					} finally {
						reader.releaseLock();
					}
				})();
				handedOff = true;
				return {
					child,
					drained,
					url,
					headers: { Authorization: `Bearer ${token}` },
					errors,
				};
			}
		} finally {
			clearTimeout(deadline);
			if (!handedOff) reader.releaseLock();
		}
	};
	const first = await boot();
	expect((await fetch(new URL("/api/state", first.url))).status).toBe(401);
	const initial = await fetch(new URL("/api/state", first.url), {
		headers: first.headers,
	});
	expect(initial.status).toBe(200);
	expect(await initial.json()).toMatchObject({
		tasks: [],
		messages: [],
		profiles: [{ id: "offline" }],
	});
	const blocked = spawn(),
		blockedError = new Response(blocked.stderr).text();
	void new Response(blocked.stdout).text();
	expect(await blocked.exited).not.toBe(0);
	expect(await blockedError).toContain("state");
	expect(
		(await fetch(new URL("/api/state", first.url), { headers: first.headers }))
			.status,
	).toBe(200);
	first.child.kill("SIGTERM");
	expect(await first.child.exited).toBe(0);
	await first.drained;
	expect(await first.errors).toBe("");
	const reopened = await boot();
	expect(
		(
			await fetch(new URL("/api/state", reopened.url), {
				headers: first.headers,
			})
		).status,
	).toBe(401);
	const current = await fetch(new URL("/api/state", reopened.url), {
		headers: reopened.headers,
	});
	expect(current.status).toBe(200);
	expect(await current.json()).toMatchObject({
		tasks: [],
		messages: [],
		profiles: [{ id: "offline" }],
	});
	reopened.child.kill("SIGTERM");
	expect(await reopened.child.exited).toBe(0);
	await reopened.drained;
	expect(await reopened.errors).toBe("");
}, 20000);
