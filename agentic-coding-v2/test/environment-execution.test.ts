import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveEnvironmentOperator } from "../src/environment/controller/operator-http.ts";
import { EnvironmentController } from "../src/environment/controller/service.ts";
import { git } from "../src/git.ts";
import { serveEnvironmentMcp } from "../src/mcp/http.ts";
import { createNativeCatalog } from "../src/mcp/native-catalog.ts";

test("scoped MCP shell actions require authenticated exact operator approval and retain real results without replay", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "environment-execution-")),
	);
	const repository = path.join(root, "repo"),
		configDir = path.join(root, "config"),
		stateDir = path.join(root, "state");
	for (const directory of [repository, configDir, stateDir])
		fs.mkdirSync(directory, { mode: 0o700 });
	await git(repository, ["init", "--quiet"]);
	await git(repository, [
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--allow-empty",
		"--quiet",
		"-m",
		"fixture",
	]);
	const script = path.join(repository, "serve.js");
	fs.writeFileSync(
		script,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript executed only by this disposable child fixture.
		'import fs from "node:fs"; fs.appendFileSync(`${process.env.WORKSPACE}/starts`, "x"); console.log(`READY ${process.env.TOKEN}`); setInterval(() => {}, 1000);',
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const secret = "disposable-fixture-secret";
	let requests = 0;
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return new Response(`${secret}\n`, {
				headers: { "content-type": "text/plain" },
			});
		},
	});
	fs.writeFileSync(
		path.join(configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository,
					defaults: { run: "serve" },
					targets: [
						{
							id: "serve",
							action: "run",
							runtime: "shell",
							command: `exec ${quote(process.execPath)} ${quote(script)}`,
							readyText: "READY",
							timeoutMs: 10000,
							secretRefs: { TOKEN: "FIXTURE_TOKEN" },
							endpoints: { web: `http://127.0.0.1:${probe.port}` },
							telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
						},
						{
							id: "waiting",
							action: "run",
							runtime: "shell",
							command: `exec ${quote(process.execPath)} ${quote(script)}`,
							readyText: "NEVER",
							timeoutMs: 10000,
						},
						{
							id: "test",
							action: "test",
							runtime: "shell",
							command: "printf 'fixture failure\\n'; exit 3",
							timeoutMs: 10000,
						},
					],
				},
			],
		}),
	);
	let controller = await EnvironmentController.open({
		stateDir,
		configDir,
		repositories: [repository],
	}).catch(async (error) => {
		await probe.stop(true);
		fs.rmSync(root, { recursive: true, force: true });
		throw error;
	});
	const principal = { id: "fixture-agent", role: "agent" as const };
	const scope = await controller.scopes.bind(principal).create({
		requestId: "scope",
		repository,
		workspace: repository,
		mode: "job",
		idleMs: 60_000,
	});
	const bound = controller.bind(principal, scope.id);
	const foreignPrincipal = { id: "foreign", role: "agent" as const };
	const otherScope = await controller.scopes.bind(foreignPrincipal).create({
		requestId: "foreign",
		repository,
		workspace: repository,
		mode: "interactive",
		idleMs: 60_000,
	});
	const firstToken = "a".repeat(64),
		secondToken = "b".repeat(64);
	const mcp = await serveEnvironmentMcp({
		controller,
		catalog: createNativeCatalog({ configDir, repositories: [repository] }),
		bindings: [
			{ token: firstToken, principal, scopeId: scope.id },
			{
				token: secondToken,
				principal: foreignPrincipal,
				scopeId: otherScope.id,
			},
		],
	});
	const client = new Client({ name: "execution-fixture", version: "1.0.0" });
	const clientTransport = new StreamableHTTPClientTransport(new URL(mcp.url), {
		requestInit: { headers: { authorization: `Bearer ${firstToken}` } },
	});
	const operator = serveEnvironmentOperator(controller.operations);
	const auth = { authorization: `Bearer ${operator.token}` };
	const call = (name: string, args: Record<string, unknown> = {}) =>
		client.callTool({ name, arguments: args });
	const inspect = (id: string) =>
		fetch(`${operator.url}/operator/operations/${id}`, { headers: auth });
	const decide = (
		id: string,
		input: unknown,
		headers: Record<string, string> = auth,
	) =>
		fetch(`${operator.url}/operator/operations/${id}/decision`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(input),
		});
	try {
		expect((await fetch(mcp.url, { method: "POST", body: "{}" })).status).toBe(
			401,
		);
		expect(
			(
				await fetch(mcp.url, {
					headers: { authorization: `Bearer ${operator.token}` },
				})
			).status,
		).toBe(401);
		expect(
			(
				await fetch(mcp.url, {
					headers: {
						authorization: `Bearer ${firstToken}`,
						origin: "https://foreign.invalid",
					},
				})
			).status,
		).toBe(403);
		await client.connect(clientTransport);
		const tools = (await client.listTools()).tools.map((tool) => tool.name);
		expect(tools).toContain("environment_action");
		expect(tools.some((name) => /approv|decid|revok/.test(name))).toBe(false);
		const admitted = await call("environment_action", {
			action: "run",
			apps: ["api"],
			requestId: "start",
		});
		expect(admitted.isError).not.toBe(true);
		expect(admitted.structuredContent).toMatchObject({
			state: "awaiting-approval",
		});
		const admittedContent = admitted.structuredContent;
		if (
			!admittedContent ||
			typeof admittedContent !== "object" ||
			!("id" in admittedContent) ||
			typeof admittedContent.id !== "string"
		)
			throw new Error("Missing operation ID");
		const id = admittedContent.id;
		await call("environment_action", { action: "execute", operationId: id });
		expect(fs.existsSync(path.join(repository, "starts"))).toBe(false);
		expect(
			(await fetch(`${operator.url}/operator/operations/${id}`)).status,
		).toBe(401);
		expect(
			(
				await fetch(`${operator.url}/operator/operations/${id}`, {
					headers: { cookie: `token=${operator.token}` },
				})
			).status,
		).toBe(401);
		expect(
			(
				await fetch(`${operator.url}/operator/operations/${id}`, {
					headers: { ...auth, origin: "https://foreign.invalid" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${operator.url}/operator/operations/${id}`, {
					headers: { ...auth, host: "foreign.invalid" },
				})
			).status,
		).toBe(403);
		const listed = await fetch(`${operator.url}/operator/operations`, {
			headers: auth,
		});
		expect(listed.status).toBe(200);
		expect(await listed.text()).not.toContain("exec ");
		const frozen = (await (await inspect(id)).json()) as {
			digest: string;
			revision: number;
			plan: string;
		};
		expect(frozen.plan).toContain("controllerGitHead");
		expect(frozen.plan).not.toContain(secret);
		const approval = {
			digest: frozen.digest,
			revision: frozen.revision,
			requestId: "approve-start",
			decision: "approved",
		};
		expect(
			(
				await decide(id, approval, {
					authorization: `Bearer ${firstToken}`,
				})
			).status,
		).toBe(401);
		expect(
			(await decide(id, { ...approval, revision: frozen.revision + 1 })).status,
		).toBe(409);
		expect(
			(await decide(id, { ...approval, principal: { role: "operator" } }))
				.status,
		).toBe(400);
		expect((await decide(id, approval)).status).toBe(200);
		expect(fs.existsSync(path.join(repository, "starts"))).toBe(false);
		fs.writeFileSync(
			path.join(configDir, ".env"),
			`FIXTURE_TOKEN=${secret}\n`,
			{ mode: 0o600 },
		);
		const issued = await call("environment_action", {
			action: "execute",
			operationId: id,
		});
		expect(issued.structuredContent).toMatchObject({ state: "issued" });
		const completed = await bound.wait(id);
		expect(completed.state).toBe("completed");
		expect((await decide(id, approval)).status).toBe(200);
		expect(completed.result).toContain("[REDACTED]");
		expect(completed.result).not.toContain(secret);
		const logs = await call("env_logs", {
			app: "api",
			grep: "[REDACTED]",
			tail: 10,
		});
		expect(logs.isError).not.toBe(true);
		expect(JSON.stringify(logs)).toContain("[REDACTED]");
		expect(JSON.stringify(logs)).not.toContain(secret);
		expect(
			(await call("otel_query", { app: "api", mode: "logs" }))
				.structuredContent,
		).toMatchObject({
			source: "native-run-otlp-http-json",
			scope: { app: "api" },
		});
		expect(
			(
				await call("db_query", {
					requestId: "no-database",
					infra: "missing",
					app: "api",
					sql: "SELECT 1",
				})
			).isError,
		).toBe(true);
		const httpPlan = await call("env_http_request", {
			requestId: "mutate-once",
			app: "api",
			endpoint: "web",
			path: "/mutate",
			method: "POST",
			allowWrite: true,
			body: "fixture mutation",
		});
		const httpContent = httpPlan.structuredContent;
		if (
			!httpContent ||
			typeof httpContent !== "object" ||
			!("id" in httpContent) ||
			typeof httpContent.id !== "string"
		)
			throw new Error("Missing diagnostic operation");
		const httpId = httpContent.id;
		expect(requests).toBe(0);
		expect((await bound.execute(httpId)).state).toBe("awaiting-approval");
		const httpFrozen = (await (await inspect(httpId)).json()) as {
			digest: string;
			revision: number;
			plan: string;
		};
		expect(httpFrozen.plan).toContain("fixture mutation");
		expect(httpFrozen.plan).not.toContain(secret);
		expect(
			(
				await decide(httpId, {
					digest: httpFrozen.digest,
					revision: httpFrozen.revision,
					requestId: "approve-http",
					decision: "approved",
				})
			).status,
		).toBe(200);
		expect(requests).toBe(0);
		await bound.execute(httpId);
		const httpCompleted = await bound.wait(httpId);
		expect(httpCompleted.state).toBe("completed");
		expect(httpCompleted.result).toContain("[REDACTED]");
		expect(httpCompleted.result).not.toContain(secret);
		const retained = JSON.parse(httpCompleted.result ?? "null") as {
			history: { run: string; operation: string };
		};
		const history = await call("env_diagnostic_history", {
			kind: "http",
			run: retained.history.run,
			operation: retained.history.operation,
		});
		expect(history.isError).not.toBe(true);
		expect(JSON.stringify(history)).not.toContain(secret);
		await bound.execute(httpId);
		await bound.wait(httpId);
		expect(requests).toBe(1);
		expect(fs.readFileSync(path.join(repository, "starts"), "utf8")).toBe("x");
		await call("environment_action", { action: "execute", operationId: id });
		expect(fs.readFileSync(path.join(repository, "starts"), "utf8")).toBe("x");
		const bridged = new Client({
			name: "stdio-second-client",
			version: "1.0.0",
		});
		const bridgeTransport = new StdioClientTransport({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("../src/mcp/cli.ts", import.meta.url)),
				"--connect",
				mcp.url,
				"--token-env",
				"ENVIRONMENT_FIXTURE_TOKEN",
			],
			env: { ENVIRONMENT_FIXTURE_TOKEN: secondToken },
			stderr: "pipe",
			cwd: repository,
		});
		let bridgeErrors = "";
		bridgeTransport.stderr?.on("data", (chunk) => {
			bridgeErrors += String(chunk);
		});
		try {
			await bridged.connect(bridgeTransport);
			expect(
				(await bridged.listTools()).tools.some(
					(tool) => tool.name === "environment_action",
				),
			).toBe(true);
			expect(
				(
					await bridged.callTool({
						name: "env_result",
						arguments: { operationId: id },
					})
				).isError,
			).toBe(true);
			expect(
				(await bridged.callTool({ name: "env_status", arguments: {} }))
					.structuredContent,
			).toMatchObject({ scope: otherScope.id, runs: [] });
			expect(
				(
					await bridged.callTool({
						name: "env_logs",
						arguments: { app: "api" },
					})
				).structuredContent,
			).toMatchObject({ runs: [] });
			expect(
				(
					await bridged.callTool({
						name: "otel_query",
						arguments: { app: "api" },
					})
				).isError,
			).toBe(true);
		} finally {
			await bridged.close();
			await bridgeTransport.close();
		}
		expect(bridgeErrors).toBe("");
		const foreign = controller.bind(
			{ id: "foreign", role: "agent" },
			otherScope.id,
		);
		await expect(foreign.result(id)).rejects.toThrow("scope-unavailable");
		expect((await foreign.status()).runs).toEqual([]);
		await foreign.stop("foreign-stop");
		expect(
			(await bound.status()).runs.some((run) => run.state === "running"),
		).toBe(true);
		expect(
			(
				await call("environment_action", {
					action: "stop",
					requestId: "forged-owner",
					owner: otherScope.owner,
				})
			).isError,
		).toBe(true);
		const testPlan = await call("environment_action", {
			action: "test",
			apps: ["api"],
			requestId: "test",
		});
		const testContent = testPlan.structuredContent;
		if (
			!testContent ||
			typeof testContent !== "object" ||
			!("id" in testContent) ||
			typeof testContent.id !== "string"
		)
			throw new Error("Missing test operation ID");
		const testId = testContent.id;
		const testFrozen = (await (await inspect(testId)).json()) as {
			digest: string;
			revision: number;
		};
		expect(
			(
				await decide(testId, {
					digest: testFrozen.digest,
					revision: testFrozen.revision,
					requestId: "approve-test",
					decision: "approved",
				})
			).status,
		).toBe(200);
		await call("environment_action", {
			action: "execute",
			operationId: testId,
		});
		expect((await bound.wait(testId)).result).toContain('"status":"failed"');
		expect((await bound.result(testId)).result).toContain('"exitCode":3');
		const denied = await bound.admit("denied", {
			action: "run",
			apps: ["api"],
		});
		expect(
			(
				await decide(denied.id, {
					digest: denied.digest,
					revision: denied.revision,
					requestId: "reject-run",
					decision: "rejected",
				})
			).status,
		).toBe(200);
		expect((await bound.execute(denied.id)).state).toBe("rejected");
		const staleHttp = await bound.http("stale-http", {
			app: "api",
			endpoint: "web",
			path: "/mutate",
			method: "POST",
			allowWrite: true,
		});
		expect(
			(
				await decide(staleHttp.id, {
					digest: staleHttp.digest,
					revision: staleHttp.revision,
					requestId: "approve-stale-http",
					decision: "approved",
				})
			).status,
		).toBe(200);
		const stop = await call("environment_action", {
			action: "stop",
			requestId: "stop",
		});
		expect(stop.structuredContent).toMatchObject({
			stopped: true,
			inspectionRequired: false,
		});
		expect(
			(await bound.status()).runs.every((run) => run.state === "exited"),
		).toBe(true);
		const replacement = await bound.admit("replacement", {
			action: "run",
			apps: ["api"],
		});
		expect(
			(
				await decide(replacement.id, {
					digest: replacement.digest,
					revision: replacement.revision,
					requestId: "approve-replacement",
					decision: "approved",
				})
			).status,
		).toBe(200);
		await bound.execute(replacement.id);
		await bound.wait(replacement.id);
		await bound.execute(staleHttp.id);
		expect((await bound.wait(staleHttp.id)).state).toBe("interrupted");
		expect(requests).toBe(1);
		await bound.stop("replacement-stop");
		const waiting = await bound.admit("waiting", {
			action: "run",
			apps: ["api"],
			target: "waiting",
		});
		expect(
			(
				await decide(waiting.id, {
					digest: waiting.digest,
					revision: waiting.revision,
					requestId: "approve-waiting",
					decision: "approved",
				})
			).status,
		).toBe(200);
		const observedStart = Promise.withResolvers<void>();
		const watcher = fs.watch(repository, (_event, file) => {
			if (
				file === "starts" &&
				fs.readFileSync(path.join(repository, "starts"), "utf8") === "xxx"
			)
				observedStart.resolve();
		});
		try {
			await bound.execute(waiting.id);
			await observedStart.promise;
			await controller.tick(Date.now() + 60_001);
			expect((await bound.status()).state).toBe("active");
			expect((await bound.stop("stop")).historical).toBe(true);
			await expect(bound.stop("stop", ["different"])).rejects.toThrow(
				"operation-request-conflict",
			);
			expect((await bound.result(waiting.id)).state).toBe("issued");
			expect(await bound.stop("cancel-startup")).toMatchObject({
				stopped: true,
			});
			expect((await bound.wait(waiting.id)).result).toContain(
				'"status":"failed"',
			);
		} finally {
			watcher.close();
		}
		const movedHead = await bound.admit("head-moved", {
			action: "run",
			apps: ["api"],
		});
		expect(
			(
				await decide(movedHead.id, {
					digest: movedHead.digest,
					revision: movedHead.revision,
					requestId: "approve-old-head",
					decision: "approved",
				})
			).status,
		).toBe(200);
		await git(repository, [
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"--quiet",
			"-m",
			"new head",
		]);
		await expect(bound.execute(movedHead.id)).rejects.toThrow(
			"operation-unavailable",
		);
		expect(fs.readFileSync(path.join(repository, "starts"), "utf8")).toBe(
			"xxx",
		);
		expect(
			(
				await call("environment_action", {
					action: "close",
					requestId: "close",
					revision: scope.revision + 1,
				})
			).isError,
		).toBe(true);
		expect(
			(
				await call("environment_action", {
					action: "close",
					requestId: "close",
					revision: scope.revision,
				})
			).structuredContent,
		).toMatchObject({ state: "completed", inspectionRequired: false });
		expect((await bound.status()).state).toBe("closed");
		expect((await bound.closeScope("close", scope.revision)).historical).toBe(
			true,
		);
		const idlePrincipal = { id: "idle-fixture", role: "agent" as const };
		const idleScope = await controller.scopes.bind(idlePrincipal).create({
			requestId: "idle-scope",
			repository,
			workspace: repository,
			mode: "interactive",
			idleMs: 60_000,
		});
		const idle = controller.bind(idlePrincipal, idleScope.id);
		const idlePlan = await idle.admit("idle-run", {
			action: "run",
			apps: ["api"],
		});
		expect(
			(
				await decide(idlePlan.id, {
					digest: idlePlan.digest,
					revision: idlePlan.revision,
					requestId: "approve-idle",
					decision: "approved",
				})
			).status,
		).toBe(200);
		await idle.execute(idlePlan.id);
		await idle.wait(idlePlan.id);
		const operatorPrincipal = {
			id: "operator-fixture",
			role: "operator" as const,
		};
		const protectedScope = await controller.scopes
			.bind(operatorPrincipal)
			.create({
				requestId: "protected",
				repository,
				workspace: repository,
				mode: "operator",
				idleMs: null,
			});
		await controller.tick(Date.now() + 60_001);
		expect((await idle.status()).state).toBe("closed");
		expect(
			(await idle.status()).runs.every((run) => run.state === "exited"),
		).toBe(true);
		expect(
			(await controller.scopes.bind(operatorPrincipal).read(protectedScope.id))
				.state,
		).toBe("active");
		await mcp.stop();
		await operator.stop();
		await controller.close();
		controller = await EnvironmentController.open({
			stateDir,
			configDir,
			repositories: [repository],
		});
		const historical = controller.bind(principal, scope.id);
		expect((await historical.result(id)).state).toBe("completed");
		expect((await historical.result(id)).historical).toBe(true);
		expect((await historical.result(httpId)).historical).toBe(true);
		expect((await historical.execute(httpId)).state).toBe("completed");
		expect(requests).toBe(1);
		expect(await historical.stop("stop")).toMatchObject({
			stopped: true,
			historical: true,
		});
		expect((await historical.execute(id)).state).toBe("completed");
		expect(fs.readFileSync(path.join(repository, "starts"), "utf8")).toBe(
			"xxxx",
		);
	} finally {
		await client.close();
		await mcp.stop();
		await operator.stop();
		await controller.close();
		await probe.stop(true);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
