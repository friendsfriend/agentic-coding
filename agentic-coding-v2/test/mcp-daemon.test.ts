import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

test("shared daemon CLI publishes private operator access and closes its own listeners and state", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-daemon-")),
	);
	const stateDir = path.join(root, "state"),
		configDir = path.join(root, "config"),
		repository = path.join(root, "repo");
	for (const directory of [stateDir, configDir, repository])
		fs.mkdirSync(directory, { mode: 0o700 });
	const clients = path.join(root, "clients.json"),
		token = "c".repeat(64);
	fs.writeFileSync(
		clients,
		JSON.stringify({
			version: 1,
			clients: [
				{
					id: "fixture",
					repository,
					workspace: repository,
					mode: "interactive",
					idleMinutes: 30,
					tokenEnv: "ENVIRONMENT_FIXTURE_TOKEN",
				},
			],
		}),
	);
	const child = Bun.spawn(
		[
			process.execPath,
			fileURLToPath(new URL("../src/mcp/cli.ts", import.meta.url)),
			"--serve",
			"--config-dir",
			configDir,
			"--state-dir",
			stateDir,
			"--clients",
			clients,
			"--repository",
			repository,
		],
		{
			cwd: repository,
			env: {
				HOME: root,
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				TMPDIR: root,
				ENVIRONMENT_FIXTURE_TOKEN: token,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const ready = Promise.withResolvers<string>();
	const stdout = new Response(child.stdout).text();
	let diagnostics = "";
	const stderr = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr) {
			diagnostics += decoder.decode(chunk, { stream: true });
			const match = /Environment MCP: (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(
				diagnostics,
			);
			if (match?.[1]) ready.resolve(match[1]);
		}
		ready.reject(new Error("Daemon exited before publishing its endpoint"));
	})();
	const client = new Client({ name: "daemon-fixture", version: "1.0.0" });
	try {
		const endpoint = await ready.promise;
		const accessFile = path.join(stateDir, "operator-access.json");
		expect(fs.statSync(accessFile).mode & 0o077).toBe(0);
		const access = JSON.parse(fs.readFileSync(accessFile, "utf8")) as {
			url: string;
			token: string;
		};
		expect(access.token).not.toBe(token);
		const control = (
			route: string,
			body?: unknown,
			credential = access.token,
		) =>
			fetch(`${access.url}/operator/controls/${route}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					authorization: `Bearer ${credential}`,
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		expect((await control("drafts", undefined, token)).status).toBe(401);
		const staged = await control("drafts/save", {
			requestId: "stage",
			content: '{"version":1,"projects":[]}',
		});
		expect(staged.status).toBe(200);
		const draft = (await staged.json()) as {
			id: string;
			revision: number;
			digest: string;
		};
		expect(await (await control("drafts")).json()).toMatchObject([
			{ id: draft.id, revision: 1 },
		]);
		expect((await control("drafts/read", { id: draft.id })).status).toBe(200);
		expect(
			(
				await control("drafts/save", {
					requestId: "conflict",
					id: draft.id,
					revision: 2,
					content: "{}",
				})
			).status,
		).not.toBe(200);
		expect(fs.existsSync(path.join(configDir, "environments.json"))).toBe(
			false,
		);
		expect(
			(await control("recovery/acknowledge", { runId: "missing", revision: 1 }))
				.status,
		).not.toBe(200);
		const promotion = { requestId: "publish", ...draft, approve: draft.digest };
		expect(
			(await control("drafts/promote", { ...promotion, approve: "wrong" }))
				.status,
		).not.toBe(200);
		const published = await control("drafts/promote", promotion);
		expect(published.status).toBe(200);
		const receipt = await published.json();
		expect(receipt).toMatchObject({
			outcome: "written",
			reloaded: false,
			runtimeChecked: false,
		});
		expect(await (await control("drafts/promote", promotion)).json()).toEqual(
			receipt,
		);
		expect(
			fs.readFileSync(path.join(configDir, "environments.json"), "utf8"),
		).toBe('{"version":1,"projects":[]}');
		expect(await (await control("recovery/runs")).json()).toMatchObject({
			runs: [],
			total: 0,
		});
		expect(
			(
				await control("recovery/revoke", {
					requestId: "missing",
					runId: "missing",
					revision: 1,
					reason: "fixture",
				})
			).status,
		).not.toBe(200);
		await client.connect(
			new StreamableHTTPClientTransport(new URL(endpoint), {
				requestInit: { headers: { authorization: `Bearer ${token}` } },
			}),
		);
		expect(
			(await client.listTools()).tools.some(
				(tool) => tool.name === "environment_action",
			),
		).toBe(true);
		expect(
			(
				await fetch(`${access.url}/operator/operations`, {
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
		).toBe(401);
		expect(
			(
				await fetch(`${access.url}/operator/operations`, {
					headers: { authorization: `Bearer ${access.token}` },
				})
			).status,
		).toBe(200);
		await client.close();
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		await stderr;
		expect(await stdout).toBe("");
		expect(diagnostics).not.toContain(token);
		expect(diagnostics).not.toContain(access.token);
		expect(fs.existsSync(accessFile)).toBe(false);
		expect(fs.existsSync(path.join(stateDir, "controller.lock"))).toBe(false);
	} finally {
		await client.close();
		if (child.exitCode === null) child.kill("SIGTERM");
		await child.exited;
		await stderr;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
