import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerManifest } from "../src/configuration/server-manifest.ts";
import type { ExecutionSession } from "../src/services/execution-service.ts";
import {
	createMultiRepositoryExecutionSession,
	createRepositoryRuntime,
	type RepositoryBinding,
} from "../src/services/multi-repository-session.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("one client routes unambiguous apps across repository scopes and refuses ambiguity", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-multi-repo-")),
	);
	const first = path.join(root, "first");
	const second = path.join(root, "second");
	const state = path.join(root, "state");
	for (const repository of [first, second]) fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	const target = (id: string) => ({
		id,
		action: "run" as const,
		runtime: "shell" as const,
		executable: {
			kind: "command" as const,
			program: "/bin/true",
			args: [],
			env: {},
			envRefs: {},
		},
	});
	const manifest = {
		version: 1,
		repositories: [first, second],
		services: [],
		apps: [
			{ id: "alpha", repository: first, targets: [target("run")] },
			{ id: "beta", repository: second, targets: [target("run")] },
			{ id: "shared", repository: first, targets: [target("run")] },
			{ id: "shared", repository: second, targets: [target("run")] },
		],
	} as unknown as ServerManifest;
	const journal = openOperationJournal(state, [first, second]);
	const calls: string[] = [];
	const makeBinding = (
		repository: string,
		owned: string[],
	): RepositoryBinding => {
		const scope = journal.createScope(
			"client",
			repository,
			repository === first ? "first-scope" : "second-scope",
		);
		const execution = {
			async admit(_request: string, intent: { app: string }) {
				calls.push(`${repository}:admit:${intent.app}`);
				return { operation: { id: `${repository}:${intent.app}` } };
			},
			read(id: string) {
				calls.push(`${repository}:read:${id}`);
				return { id };
			},
			history() {
				return {
					operations: [
						{ createdAt: repository === first ? 1 : 2, id: repository },
					],
					total: 1,
					nextOffset: null,
				};
			},
			sharedServices: () => [],
			sharedService: () => null,
			isBusy: () => false,
			status() {
				return {
					scope: { id: scope.id, state: "active", revision: 1 },
					owned: owned.map((app) => ({
						id: `${repository}:${app}`,
						app,
						kind: "container" as const,
						runtimeId: `${repository}:${app}`,
						createdAt: 1,
					})),
					authority: "test",
				};
			},
			async stop(app: string) {
				calls.push(`${repository}:stop:${app}`);
				return { stopped: [app], remaining: 0, retainedLogsAvailable: false };
			},
			async logs(app: string) {
				return { app, tail: 10, historical: false, output: repository };
			},
			telemetry(app: string) {
				if (repository !== first) throw new Error("operation-unavailable");
				return { app, transport: "loopback" };
			},
			async shutdown() {},
		} as unknown as ExecutionSession;
		const operations = {
			async admit(_request: string, intent: { app: string }) {
				calls.push(`${repository}:prepare:${intent.app}`);
				return { operation: { id: `${repository}:prepare:${intent.app}` } };
			},
			read() {
				return {};
			},
			history() {
				return {
					operations: [
						{ createdAt: repository === first ? 1 : 2, id: repository },
					],
					total: 1,
					nextOffset: null,
				};
			},
			sharedServices: () => [],
			sharedService: () => null,
			issue: async () => ({}),
			complete: async () => ({}),
			closeScope: () => ({}),
			owned: () => [],
		} as unknown as RepositoryBinding["operations"];
		return {
			repository,
			scopeId: scope.id,
			scope,
			execution,
			operations,
		};
	};
	const bindings = [
		makeBinding(first, ["alpha", "shared"]),
		makeBinding(second, ["beta", "shared"]),
	];
	const session = createMultiRepositoryExecutionSession(
		manifest,
		journal,
		bindings.map((binding) =>
			createRepositoryRuntime({
				repository: binding.repository,
				create: () => binding,
			}),
		),
	);
	const signal = new AbortController().signal;
	try {
		expect(
			await session.admit("one", { app: "alpha", target: "run" }, signal),
		).toMatchObject({ operation: { id: `${first}:alpha` } });
		expect(
			await session.admit("two", { app: "beta", target: "run" }, signal),
		).toMatchObject({ operation: { id: `${second}:beta` } });
		await expect(
			session.admit("three", { app: "shared", target: "run" }, signal),
		).rejects.toMatchObject({ code: "repository-ambiguous" });
		expect(
			await session.admit(
				"four",
				{ app: "shared", target: "run", repository: second },
				signal,
			),
		).toMatchObject({ operation: { id: `${second}:shared` } });
		expect(session.status()).toMatchObject({
			scopes: [
				{ repository: first, owned: 2 },
				{ repository: second, owned: 2 },
			],
			owned: [
				{ app: "alpha" },
				{ app: "shared" },
				{ app: "beta" },
				{ app: "shared" },
			],
		});
		expect(await session.stop("alpha", signal)).toMatchObject({
			stopped: ["alpha"],
		});
		await expect(session.stop("shared", signal)).rejects.toMatchObject({
			code: "repository-ambiguous",
		});
		expect(await session.logs("beta", 10, signal)).toMatchObject({
			output: second,
		});
		expect(await session.telemetry("alpha")).toMatchObject({
			repository: first,
			transport: "loopback",
		});
		expect(session.history()).toMatchObject({
			total: 2,
			operations: [{ id: second }, { id: first }],
		});
		expect(calls).toEqual([
			`${first}:admit:alpha`,
			`${second}:admit:beta`,
			`${second}:admit:shared`,
			`${first}:stop:alpha`,
		]);
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
