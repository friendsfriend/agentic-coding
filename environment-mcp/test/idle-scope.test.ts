import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createDependencyOperationService } from "../src/services/dependency-operation-service.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import {
	closeIdleRepository,
	createRepositoryRuntime,
} from "../src/services/multi-repository-session.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("an idle repository scope closes and reopens while retaining historical scope lookup", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-idle-scope-")),
	);
	const repository = path.join(root, "repo");
	const state = path.join(root, "state");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		services: [],
		apps: [
			{
				id: "api",
				repository,
				targets: [
					{
						id: "run",
						action: "run",
						runtime: "shell",
						executable: {
							kind: "command",
							program: "/bin/true",
							args: [],
							env: {},
							envRefs: {},
						},
					},
				],
			},
		],
	});
	const journal = openOperationJournal(state, [repository]);
	const execution = createExecutionService(
		manifest,
		journal,
		{ inspect: async () => ({ status: "absent" as const }) },
		{} as ExecutionPort,
		{ get: () => undefined },
	);
	const operations = createDependencyOperationService(manifest, journal, {
		inspect: async () => ({ status: "absent" as const }),
	});
	const runtime = createRepositoryRuntime({
		repository,
		create: () => {
			const scope = journal.createScope("client", repository, randomUUID());
			return {
				repository,
				scopeId: scope.id,
				scope,
				execution: execution.bind("client", scope.id),
				operations: operations.bind("client", scope.id),
			};
		},
	});
	const first = runtime.current.scopeId;
	try {
		expect(await closeIdleRepository(runtime, journal)).toBe(true);
		expect(runtime.current.scope).toMatchObject({ state: "closed" });
		expect(runtime.find(first)?.execution).toBeDefined();
		const reopened = runtime.active();
		expect(reopened.scope.state).toBe("active");
		expect(reopened.scopeId).not.toBe(first);
		expect(runtime.retired.map((binding) => binding.scopeId)).toEqual([first]);
		expect(runtime.find(first)?.scope.state).toBe("closed");
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
