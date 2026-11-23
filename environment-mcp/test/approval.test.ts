import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import { serveMcpHttp } from "../src/mcp/serve-http.ts";
import { serveOperatorApi } from "../src/operator/serve-operator-api.ts";
import { createCatalogService } from "../src/services/catalog-service.ts";
import { createDependencyOperationService } from "../src/services/dependency-operation-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("scoped dependency review requires exact human approval, fences issuance and retains conservative restart history", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-")),
	);
	const repository = path.join(root, "repo"),
		state = path.join(root, "state");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	let journal = openOperationJournal(state, [repository]);
	let operator = serveOperatorApi(journal.operator());
	const token = operator.token;
	const secret = "private-inspection-value";
	let generation = "a".repeat(64),
		observations = 0;
	const binding = {
		kind: "docker-container",
		socket: "/configured-only/docker.sock",
		containerName: "postgres",
		image: "postgres:17.4",
		labels: { "com.docker.compose.project": "existing-mocked" },
		network: { name: "existing-mocked_devenv-local", alias: "postgres" },
		readiness: "running",
	};
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		services: [{ id: "postgres", runtime: "docker", binding }],
		apps: [
			{
				id: "api",
				repository,
				targets: [
					{
						id: "mocked",
						action: "run",
						runtime: "compose",
						dependsOn: [{ service: "postgres" }],
					},
				],
			},
		],
	});
	const containers = {
		async inspect() {
			observations++;
			return {
				status: "present" as const,
				document: {
					Id: generation,
					Name: "/postgres",
					Created: "2026-01-01T00:00:00Z",
					Image: `sha256:${"b".repeat(64)}`,
					Config: {
						Image: "postgres:17.4",
						Labels: binding.labels,
						Env: [secret],
					},
					State: {
						Running: true,
						Paused: false,
						Restarting: false,
						Dead: false,
						StartedAt: "2026-01-01T00:01:00Z",
					},
					NetworkSettings: {
						Networks: {
							[binding.network.name]: {
								NetworkID: "c".repeat(64),
								Aliases: ["postgres"],
							},
						},
					},
				},
			};
		},
	};
	const request = (
		route: string,
		body?: unknown,
		credential = token,
		origin?: string,
	) =>
		fetch(`${operator.url}${route}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${credential}`,
				"content-type": "application/json",
				...(origin ? { origin } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const approve = async (
		operation: { id: string; digest: string; revision: number },
		requestId: string,
	) =>
		request(`/operator/operations/${operation.id}/decision`, {
			digest: operation.digest,
			revision: operation.revision,
			requestId,
			decision: "approved",
		});
	const signal = new AbortController().signal;
	let mcp: ReturnType<typeof serveMcpHttp> | undefined;
	const client = new Client({ name: "approval-boundary", version: "1.0.0" });
	try {
		expect(() => openOperationJournal(state, [repository])).toThrow(
			"journal-unavailable",
		);
		const scope = journal.createScope("client", repository, "scope");
		const foreignScope = journal.createScope(
			"other-client",
			repository,
			"scope",
		);
		const service = createDependencyOperationService(
			manifest,
			journal,
			containers,
		);
		const agent = service.bind("client", scope.id),
			foreign = service.bind("other-client", foreignScope.id);
		const file = path.join(root, "manifest.json");
		fs.writeFileSync(file, JSON.stringify(manifest));
		const agentToken = "m".repeat(64);
		mcp = serveMcpHttp(
			createCatalogService({ file, format: "manifest", repositories: [] }),
			[{ token: agentToken, operations: agent }],
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL(mcp.url), {
				requestInit: { headers: { authorization: `Bearer ${agentToken}` } },
			}),
		);
		expect(
			(await client.listTools()).tools.map((tool) => tool.name).sort(),
		).toEqual([
			"env_history",
			"env_list",
			"env_operation",
			"env_prepare_dependencies",
			"env_services",
		]);
		const prepared = await client.callTool({
			name: "env_prepare_dependencies",
			arguments: { requestId: "first", app: "api", target: "mocked" },
		});
		const content = prepared.structuredContent;
		if (
			!content ||
			typeof content !== "object" ||
			!("id" in content) ||
			typeof content.id !== "string"
		)
			throw new Error("Missing dependency review receipt");
		const admitted = agent.read(content.id);
		expect(
			(
				await client.callTool({
					name: "env_operation",
					arguments: { operationId: admitted.id },
				})
			).structuredContent,
		).toMatchObject({ state: "awaiting-approval" });
		expect(
			(await fetch(mcp.url, { headers: { authorization: `Bearer ${token}` } }))
				.status,
		).toBe(401);
		expect(admitted.state).toBe("awaiting-approval");
		expect(observations).toBe(1);
		expect(await agent.issue(admitted.id, signal)).toMatchObject({
			permit: null,
			operation: { state: "awaiting-approval" },
		});
		expect(
			(await agent.admit("first", { target: "mocked", app: "api" }, signal)).id,
		).toBe(admitted.id);
		expect(observations).toBe(1);
		await expect(
			agent.admit("first", { app: "api", target: "other" }, signal),
		).rejects.toThrow("request-conflict");
		expect(() => foreign.read(admitted.id)).toThrow("operation-unavailable");
		expect(
			(await request("/operator/operations", undefined, agentToken)).status,
		).toBe(401);
		expect(
			(
				await request(
					"/operator/operations",
					undefined,
					token,
					"https://foreign.invalid",
				)
			).status,
		).toBe(403);
		const listing = await (await request("/operator/operations")).json();
		expect(JSON.stringify(listing)).not.toContain(binding.network.name);
		const inspected = (await (
			await request(`/operator/operations/${admitted.id}`)
		).json()) as { plan: string };
		expect(inspected.plan).toContain(generation);
		expect(inspected.plan).not.toContain(secret);
		expect(
			(await approve({ ...admitted, digest: "0".repeat(64) }, "stale")).status,
		).toBe(409);
		expect((await approve(admitted, "approve-first")).status).toBe(200);
		expect(observations).toBe(1);
		const issuances = await Promise.all([
			agent.issue(admitted.id, signal),
			agent.issue(admitted.id, signal),
		]);
		const issued = issuances.find((issuance) => issuance.permit !== null);
		expect(
			issuances.filter((issuance) => issuance.permit !== null),
		).toHaveLength(1);
		if (!issued?.permit) throw new Error("Missing fixture permit");
		await expect(
			foreign.complete(issued.permit, { fixture: true }, signal),
		).rejects.toThrow("operation-unavailable");
		await expect(
			agent.complete({ ...issued.permit }, { fixture: true }, signal),
		).rejects.toThrow("operation-unavailable");
		expect(
			(
				await agent.complete(
					issued.permit,
					{
						fixtureAcknowledgement: true,
						authority: "No runtime effect was executed",
					},
					signal,
				)
			).state,
		).toBe("completed");
		expect(await agent.issue(admitted.id, signal)).toMatchObject({
			permit: null,
			operation: { state: "completed" },
		});
		expect((await approve(admitted, "approve-first")).status).toBe(200);
		const uncertain = await agent.admit(
			"uncertain",
			{ app: "api", target: "mocked" },
			signal,
		);
		expect((await approve(uncertain, "approve-uncertain")).status).toBe(200);
		expect((await agent.issue(uncertain.id, signal)).permit).not.toBeNull();
		const stale = await agent.admit(
			"replaced",
			{ app: "api", target: "mocked" },
			signal,
		);
		expect((await approve(stale, "approve-replaced")).status).toBe(200);
		generation = "d".repeat(64);
		await expect(agent.issue(stale.id, signal)).rejects.toThrow(
			"dependency-generation-changed",
		);
		expect(agent.read(stale.id).state).toBe("approved");
		await client.close();
		await mcp.stop();
		await operator.stop();
		journal.close();
		journal = openOperationJournal(state, [repository]);
		operator = serveOperatorApi(journal.operator());
		const historical = createDependencyOperationService(
			manifest,
			journal,
			containers,
		).bind("client", scope.id);
		const acknowledge = (
			operation: { id: string; digest: string; revision: number },
			requestId: string,
		) =>
			request(
				`/operator/operations/${operation.id}/acknowledge`,
				{
					digest: operation.digest,
					revision: operation.revision,
					requestId,
				},
				operator.token,
			);
		expect(historical.read(admitted.id)).toMatchObject({
			state: "completed",
			historical: true,
		});
		const uncertainView = historical.read(uncertain.id);
		expect(uncertainView).toMatchObject({
			state: "interrupted",
			inspectionRequired: true,
		});
		expect((await acknowledge(uncertainView, "ack-uncertain")).status).toBe(
			200,
		);
		expect((await acknowledge(uncertainView, "ack-uncertain")).status).toBe(
			200,
		);
		expect(
			(
				await acknowledge(
					{ ...uncertainView, digest: "0".repeat(64) },
					"stale-ack",
				)
			).status,
		).toBe(409);
		expect(historical.read(uncertain.id)).toMatchObject({
			state: "interrupted",
			inspectionRequired: false,
			revision: uncertainView.revision + 1,
		});
		expect(historical.read(stale.id)).toMatchObject({
			state: "interrupted",
			inspectionRequired: false,
		});
		const before = observations;
		expect(
			(
				await historical.admit(
					"first",
					{ app: "api", target: "mocked" },
					signal,
				)
			).id,
		).toBe(admitted.id);
		expect((await historical.issue(uncertain.id, signal)).permit).toBeNull();
		expect(observations).toBe(before);
	} finally {
		await client.close();
		await mcp?.stop();
		await operator.stop();
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
