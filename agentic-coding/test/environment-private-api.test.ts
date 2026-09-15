// Private environment operations (port-project-catalog-and-state-to-bun, tasks
// 3.1, 3.3), retained after the Go client was retired: the bounded operation
// envelope is now the server's own in-process state/config boundary, so these
// tests assert the contract the routes depend on — authorization, bounds, one
// logical operation per request and no recursion into a second runtime.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvironmentAuthority } from "../src/server/environment/authority.ts";
import {
	ENVIRONMENT_OPERATION_PATH,
	EnvironmentOperationError,
	environmentOperationSchema,
	executeEnvironmentOperation,
} from "../src/server/environment/private-api.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import { routeOwner } from "../src/server/protocol.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures", "environment");

interface Fixture {
	dir: string;
	home: string;
	configDir: string;
	cleanup: () => void;
}

/** A temporary home/config pair seeded from the captured fixtures. The body is
 * awaited before the store is closed, so a transport test can still use the
 * authority while its server is running. */
async function withAuthority(
	work: (
		authority: ReturnType<typeof createEnvironmentAuthority>,
		fixture: Fixture,
	) => void | Promise<void>,
	options: { configFixture?: string } = {},
): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-private-"));
	const home = path.join(dir, "home");
	const configDir = path.join(dir, "config");
	fs.mkdirSync(home, { recursive: true });
	fs.cpSync(
		path.join(FIXTURES, "config", options.configFixture ?? "worktree-apps"),
		configDir,
		{ recursive: true },
	);
	try {
		const authority = createEnvironmentAuthority({ homeDir: home, configDir });
		try {
			await work(authority, {
				dir,
				home,
				configDir,
				cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
			});
		} finally {
			authority.state.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function operation(operation: string, params: unknown = {}) {
	return { operation, params };
}

describe("environment operation contract", () => {
	test("the manifest covers the private path and no delegated prefix", () => {
		expect(routeOwner("POST", ENVIRONMENT_OPERATION_PATH)?.owner).toBe("bun");
		// The public delegated prefix is gone: a request that used to be
		// forwarded to the child now matches nothing and is a 404.
		expect(routeOwner("POST", "/api/v1/environment/api/apps")).toBeUndefined();
		expect(
			routeOwner("GET", "/api/v1/environment/api/projects"),
		).toBeUndefined();
	});

	test("one logical operation per request, decoded against a bounded schema", () => {
		expect(executeEnvironmentOperation).toBeTypeOf("function");
		const decoded = environmentOperationSchema;
		expect(decoded).toBeDefined();
		// No SQL, table or column can travel on the wire: the operation name is a
		// closed literal set, so an unnamed statement is rejected before dispatch.
		expect(() =>
			executeEnvironmentOperation(
				{} as never,
				operation("state.exec", { sql: "DROP TABLE app_state" }),
			),
		).toThrow(EnvironmentOperationError);
		expect(() =>
			executeEnvironmentOperation({} as never, {
				operation: "state.getAppState",
				params: { ident: "alpha" },
				maxEntries: 5,
			}),
		).toThrow(EnvironmentOperationError);
	});

	test("state and manager operations round-trip through the authority", async () => {
		await withAuthority((authority) => {
			// State: an upsert is one operation, so an atomic multi-field update
			// cannot be split across requests.
			executeEnvironmentOperation(
				authority,
				operation("state.setAppState", {
					ident: "alpha",
					branch: "feature/x",
					activeWorktree: "feature/x",
					mainWorktreeBranch: "main",
				}),
			);
			expect(
				executeEnvironmentOperation(
					authority,
					operation("state.getAppState", { ident: "alpha" }),
				),
			).toEqual({
				ident: "alpha",
				branch: "feature/x",
				activeWorktree: "feature/x",
				mainWorktreeBranch: "main",
			});
			// An absent run target is `null` on the wire, never an empty record.
			expect(
				executeEnvironmentOperation(
					authority,
					operation("state.getAppRunTargetInfo", { ident: "alpha" }),
				),
			).toBeNull();
			executeEnvironmentOperation(
				authority,
				operation("state.setAppRunTargetInfo", {
					ident: "alpha",
					info: {
						runtime: "docker",
						launchMode: "compose",
						label: "local",
						profile: "dev",
						targetId: "app:local",
						sourcePath: "/srv/app",
						startedAt: "2024-03-04T05:06:07Z",
						display: "docker:local",
					},
				}),
			);
			expect(
				executeEnvironmentOperation(
					authority,
					operation("state.getAppRunTargetInfo", { ident: "alpha" }),
				),
			).toMatchObject({ display: "docker:local" });

			// History: one insert performs its own retention trim.
			for (let index = 0; index < 4; index++)
				executeEnvironmentOperation(
					authority,
					operation("state.addActionLogEvent", {
						runId: "run-1",
						stepId: "step-1",
						eventJson: `{"type":"action.step.output","properties":{"text":"${index}"}}`,
						maxEntries: 2,
					}),
				);
			expect(
				executeEnvironmentOperation(
					authority,
					operation("state.getActionLogEvents", {
						runId: "run-1",
						stepId: "step-1",
						limit: 50,
					}),
				),
			).toHaveLength(2);

			// Leases are keyed by (target, owner run) and idempotent.
			const lease = {
				targetId: "lease:db",
				ownerRunId: "run-1",
				ownerApp: "alpha",
				lifecycle: "owned",
				updatedAt: "2024-04-05T06:07:08Z",
			};
			executeEnvironmentOperation(
				authority,
				operation("state.setDependencyLease", lease),
			);
			executeEnvironmentOperation(
				authority,
				operation("state.setDependencyLease", lease),
			);
			expect(
				executeEnvironmentOperation(
					authority,
					operation("state.getDependencyLeases"),
				),
			).toHaveLength(1);
			executeEnvironmentOperation(
				authority,
				operation("state.deleteDependencyLease", {
					targetId: "lease:db",
					ownerRunId: "run-1",
				}),
			);
			expect(
				executeEnvironmentOperation(
					authority,
					operation("state.getDependencyLeases"),
				),
			).toHaveLength(0);
		});
	});

	test("a config reload returns the new snapshot in the same response", async () => {
		await withAuthority(
			(authority, fixture) => {
				const before = executeEnvironmentOperation(
					authority,
					operation("manager.getApps"),
				) as { apps: Array<{ ident: string }>; infraServices: unknown[] };
				expect(before.apps.map((app) => app.ident)).toEqual([
					"alpha",
					"beta",
					"delta",
					"gamma",
				]);
				fs.writeFileSync(
					path.join(fixture.configDir, "apps", "definitions", "epsilon.json"),
					'{"ident":"epsilon","displayName":"Epsilon","repositoryPath":"https://example.com/epsilon.git"}',
				);
				const after = executeEnvironmentOperation(
					authority,
					operation("manager.loadConfig"),
				) as { apps: Array<{ ident: string }> };
				expect(after.apps.map((app) => app.ident)).toContain("epsilon");
			},
			{ configFixture: "worktree-apps" },
		);
	});

	test("an invalid configuration reload is a bounded diagnostic, not a partial publish", async () => {
		await withAuthority((authority, fixture) => {
			const before = executeEnvironmentOperation(
				authority,
				operation("manager.loadConfig"),
			) as { apps: Array<{ ident: string }> };
			const infraDir = path.join(
				fixture.configDir,
				"infrastructure",
				"definitions",
			);
			fs.mkdirSync(infraDir, { recursive: true });
			fs.writeFileSync(
				path.join(infraDir, "broken.json"),
				'{ "ident": "broken", "type": "kubernetes" }',
			);
			expect(() =>
				executeEnvironmentOperation(authority, operation("manager.loadConfig")),
			).toThrow(/requires kubernetes config/);
			// The previously published snapshot is still served.
			const after = executeEnvironmentOperation(
				authority,
				operation("manager.getApps"),
			) as { apps: Array<{ ident: string }> };
			expect(after.apps.map((app) => app.ident)).toEqual(
				before.apps.map((app) => app.ident),
			);
		});
	});

	test("the catalog projection keeps Go's payload shape and revision length", async () => {
		await withAuthority((authority) => {
			const catalog = executeEnvironmentOperation(
				authority,
				operation("manager.getProjectCatalog"),
			) as { revision: string; projects: Array<{ ident: string }> };
			expect(catalog.revision).toHaveLength(16);
			expect(catalog.projects.map((project) => project.ident)).toEqual([
				"alpha",
				"beta",
				"delta",
				"gamma",
			]);
		});
	});
});

describe("rollback and ownership preconditions", () => {
	test("this process is the only environment owner", async () => {
		// The mixed-runtime owner switch is gone with the Go backend: there is no
		// second generation to select, and a rollback is a deliberate restore of a
		// verified pre-upgrade database instead of a runtime fallback. The marker
		// only survives in the comment that records why it was removed.
		const authoritySource = await Bun.file(
			path.join(
				import.meta.dir,
				"..",
				"src",
				"server",
				"environment",
				"authority.ts",
			),
		).text();
		expect(authoritySource).not.toMatch(/bunOwnsEnvironment|process\.env\./);
	});

	test("a newer schema fails closed and leaves the verified backup untouched", async () => {
		// The rollback gate: an upgrade refuses to run against a database written
		// by a newer release, so an older writer is never started on newer state.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-rollback-"));
		const home = path.join(dir, "home");
		const configDir = path.join(dir, "config");
		fs.mkdirSync(path.join(home, "db"), { recursive: true });
		fs.mkdirSync(configDir, { recursive: true });
		fs.copyFileSync(
			path.join(FIXTURES, "future", "state.db"),
			path.join(home, "db", "state.db"),
		);
		try {
			expect(() =>
				createEnvironmentAuthority({ homeDir: home, configDir }),
			).toThrow(/newer than the supported/);
			// No upgrade backup was written for an unsupported version.
			expect(
				fs
					.readdirSync(path.join(home, "db"))
					.filter((entry) => entry.includes("backup")),
			).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an interrupted upgrade is completed before the authority serves reads", () => {
		// A partial-v4 database is the interrupted-upgrade case: the authority
		// completes it (and keeps a verified backup at the old version) instead of
		// failing or serving a half-migrated schema.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-interrupted-"));
		const home = path.join(dir, "home");
		const configDir = path.join(dir, "config");
		fs.mkdirSync(path.join(home, "db"), { recursive: true });
		fs.cpSync(path.join(FIXTURES, "config", "worktree-apps"), configDir, {
			recursive: true,
		});
		fs.copyFileSync(
			path.join(FIXTURES, "partial-v4", "state.db"),
			path.join(home, "db", "state.db"),
		);
		try {
			const recovered = createEnvironmentAuthority({
				homeDir: home,
				configDir,
			});
			try {
				expect(recovered.state.schemaVersion).toBe(7);
				expect(recovered.state.getAppState("half-migrated-app")).toMatchObject({
					branch: "main",
					mainWorktreeBranch: "main",
				});
				expect(fs.existsSync(path.join(home, "db", "state.db.backup-v3"))).toBe(
					true,
				);
			} finally {
				recovered.state.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("private environment transport", () => {
	async function withServer(
		authority: ReturnType<typeof createEnvironmentAuthority>,
		work: (
			server: Awaited<ReturnType<typeof startWorkflowServer>>,
		) => Promise<void>,
		environmentBaseUrl?: string,
	): Promise<void> {
		const server = await startWorkflowServer({
			environment: authority,
			...(environmentBaseUrl
				? { environmentBaseUrl, environmentToken: "private-token" }
				: {}),
		});
		try {
			await work(server);
		} finally {
			await server.stop();
		}
	}

	const call = (server: { url: string; token: string }, body: unknown) =>
		fetch(`${server.url}${ENVIRONMENT_OPERATION_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${server.token}`,
			},
			body: JSON.stringify(body),
		});

	test("authorization, bounds and unknown operations are rejected", async () => {
		await withAuthority(async (authority) => {
			await withServer(authority, async (server) => {
				const unauthorized = await fetch(
					`${server.url}${ENVIRONMENT_OPERATION_PATH}`,
					{
						method: "POST",
						body: JSON.stringify(operation("manager.getApps")),
					},
				);
				expect(unauthorized.status).toBe(401);

				const oversized = await call(server, {
					operation: "state.getAppState",
					params: { ident: "x".repeat(5000) },
				});
				expect(oversized.status).toBe(400);

				const unknown = await call(server, operation("state.exec", {}));
				expect(unknown.status).toBe(400);
				expect(await unknown.json()).toMatchObject({
					error: { code: "invalid-operation" },
				});

				const excess = await call(server, {
					operation: "manager.getApps",
					params: {},
					sql: "SELECT 1",
				});
				expect(excess.status).toBe(400);

				const ok = await call(server, operation("manager.getApps"));
				expect(ok.status).toBe(200);
				expect(await ok.json()).toMatchObject({
					ok: true,
					value: { apps: expect.any(Array) },
				});
			});
		});
	});

	test("the private path never calls back into the delegated Go child", async () => {
		await withAuthority(async (authority) => {
			// A base URL nobody serves: any recursion into the environment child
			// would fail, so a successful private operation proves independence.
			await withServer(
				authority,
				async (server) => {
					const privateCall = await call(
						server,
						operation("state.setBranch", { ident: "alpha", branch: "main" }),
					);
					expect(privateCall.status).toBe(200);
					expect(
						executeEnvironmentOperation(
							authority,
							operation("state.getAppState", { ident: "alpha" }),
						),
					).toMatchObject({ branch: "main" });

					// The delegated environment prefix still targets the child, and
					// that is the only route that needs it.
					const delegated = await fetch(
						`${server.url}/api/v1/environment/api/apps`,
						{ headers: { authorization: `Bearer ${server.token}` } },
					);
					expect(delegated.ok).toBe(false);
				},
				"http://127.0.0.1:1",
			);
		});
	});

	test("without an authority the private route reports unavailable, not a crash", async () => {
		const server = await startWorkflowServer({});
		try {
			const response = await fetch(
				`${server.url}${ENVIRONMENT_OPERATION_PATH}`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${server.token}`,
					},
					body: JSON.stringify(operation("manager.getApps")),
				},
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				error: { code: "environment-unavailable" },
			});
		} finally {
			await server.stop();
		}
	});
});
