import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnosticQueryInput } from "../src/environment/controller/diagnostic-input.ts";
import { ControllerOperations } from "../src/environment/controller/operations.ts";
import { scopeIdleExpired } from "../src/environment/controller/scope-idle.ts";
import {
	ControllerScopes,
	type ScopeRequest,
} from "../src/environment/controller/scopes.ts";
import { ControllerPersistence } from "../src/environment/controller/sqlite-persistence.ts";
import type { Plan } from "../src/environment/model.ts";
import { EnvironmentState } from "../src/environment/state.ts";

test("scope idle rule protects operator infrastructure, active work and clock rollback", () => {
	const scope = {
		state: "active" as const,
		mode: "job" as const,
		createdAt: 100,
		idleMs: 60_000,
	};
	expect(scopeIdleExpired(scope, undefined, false, 60_100)).toBe(true);
	expect(scopeIdleExpired(scope, 1000, false, 60_100)).toBe(false);
	expect(scopeIdleExpired(scope, 1000, false, 999)).toBe(false);
	expect(scopeIdleExpired(scope, undefined, true, 60_100)).toBe(false);
	expect(
		scopeIdleExpired(
			{ ...scope, mode: "operator", idleMs: null },
			undefined,
			false,
			100_000,
		),
	).toBe(false);
	expect(
		scopeIdleExpired({ ...scope, state: "closed" }, undefined, false, 100_000),
	).toBe(false);
});

test("controller scopes persist without an agent harness, fence owners and never regain live authority on reopen", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "environment-controller-")),
	);
	const state = path.join(root, "state"),
		repository = path.join(root, "repo"),
		workspace = path.join(repository, "workspace");
	fs.mkdirSync(state, { mode: 0o700 });
	fs.mkdirSync(repository);
	fs.mkdirSync(workspace);
	let store = ControllerPersistence.open(state);
	try {
		expect(() => ControllerPersistence.open(state)).toThrow(
			"controller-store-unavailable",
		);
		let scopes = await ControllerScopes.open(store, [repository]);
		let alice = scopes.bind({ id: "alice", role: "agent" });
		const bob = scopes.bind({ id: "bob", role: "agent" });
		const request: ScopeRequest = {
			requestId: "work",
			repository,
			workspace,
			mode: "job",
			idleMs: 60_000,
		};
		const [job, sameJob] = await Promise.all([
			alice.create(request),
			alice.create({ ...request }),
		]);
		expect(sameJob.id).toBe(job.id);
		expect(job).toMatchObject({ state: "active", mode: "job", idleMs: 60_000 });
		await expect(bob.read(job.id)).rejects.toThrow("scope-unavailable");
		await expect(bob.beginClose(job.id, job.revision)).rejects.toThrow(
			"scope-unavailable",
		);
		await expect(alice.create({ ...request, idleMs: 120_000 })).rejects.toThrow(
			"scope-request-conflict",
		);
		await expect(
			alice.create({
				...request,
				requestId: "infrastructure",
				mode: "operator",
				idleMs: null,
			}),
		).rejects.toThrow("invalid-scope-request");
		const infrastructure = await scopes
			.bind({ id: "developer", role: "operator" })
			.create({
				...request,
				requestId: "infra",
				mode: "operator",
				idleMs: null,
			});
		expect(infrastructure).toMatchObject({ mode: "operator", idleMs: null });
		let resolutions = 0;
		const plan: Plan = {
			id: "serve",
			app: "api",
			action: "run",
			runtime: "shell",
			command: "echo never dispatched",
			workspace,
			cwd: workspace,
			timeoutMs: 1000,
			readyText: null,
			environment: {},
			secretRefs: {},
		};
		let operations = await ControllerOperations.open(
			store,
			scopes,
			async () => {
				resolutions++;
				return [plan];
			},
		);
		let agentOperations = operations.bind({ id: "alice", role: "agent" });
		const intent = { apps: ["api"], action: "run" };
		const pending = await agentOperations.admit(job.id, "start-api", intent);
		expect(pending.state).toBe("awaiting-approval");
		await expect(agentOperations.issue(pending.id, pending)).rejects.toThrow(
			"operation-unavailable",
		);
		await expect(
			operations.bind({ id: "bob", role: "agent" }).read(pending.id),
		).rejects.toThrow("scope-unavailable");
		expect(() => operations.operator({ id: "alice", role: "agent" })).toThrow(
			"operation-unavailable",
		);
		plan.command = "echo changed configuration";
		expect(
			(
				await agentOperations.admit(job.id, "start-api", {
					action: "run",
					apps: ["api"],
				})
			).plan,
		).toBe(pending.plan);
		expect(resolutions).toBe(1);
		await expect(
			agentOperations.admit(job.id, "start-api", {
				...intent,
				target: "different",
			}),
		).rejects.toThrow("operation-request-conflict");
		const operator = operations.operator({ id: "developer", role: "operator" });
		const sqlInput = diagnosticQueryInput({
			infra: "store",
			app: "api",
			sql: "SELECT 123 /* exact diagnostic */",
		});
		const sqlSnapshot = {
			kind: "sql" as const,
			input: sqlInput,
			authority: "Fixture review only; no query is dispatched",
			request: {
				input: sqlInput,
				run: "held-run",
				app: "api",
				connection: {
					protocol: "postgres" as const,
					host: "127.0.0.1" as const,
					port: 5432,
					database: "fixture",
					usernameRef: "U",
					passwordRef: "P",
				},
			},
		};
		const sql = await agentOperations.admitDiagnostic(
			job.id,
			"query",
			"sql",
			sqlInput,
			async () => sqlSnapshot,
		);
		expect(sql.kind).toBe("sql");
		expect(JSON.stringify(await operator.list())).not.toContain(sqlInput.sql);
		expect((await operator.inspect(sql.id)).plan).toContain(sqlInput.sql);
		expect(
			(
				await agentOperations.admitDiagnostic(
					job.id,
					"query",
					"sql",
					{ ...sqlInput },
					async () => {
						throw new Error("Replay must not prepare a new query");
					},
				)
			).id,
		).toBe(sql.id);
		await expect(
			agentOperations.admitDiagnostic(
				job.id,
				"query",
				"sql",
				{ ...sqlInput, sql: "SELECT 456" },
				async () => sqlSnapshot,
			),
		).rejects.toThrow("operation-request-conflict");
		await expect(agentOperations.issue(sql.id, sql)).rejects.toThrow(
			"operation-unavailable",
		);
		const sqlApproved = await operator.decide(sql.id, {
			digest: sql.digest,
			revision: sql.revision,
			requestId: "approve-query",
			decision: "approved",
		});
		await agentOperations.complete(
			await agentOperations.issue(sql.id, sqlApproved),
			"Fixture acknowledgement only; no database connection",
		);
		const decision = {
			revision: pending.revision,
			digest: pending.digest,
			requestId: "approve-api",
			decision: "approved" as const,
		};
		await expect(
			operator.decide(pending.id, {
				...decision,
				revision: pending.revision + 1,
			}),
		).rejects.toThrow("operation-unavailable");
		const approved = await operator.decide(pending.id, decision);
		const permit = await agentOperations.issue(pending.id, approved);
		expect(permit.operation).toMatchObject({
			state: "issued",
			plan: pending.plan,
		});
		await expect(agentOperations.issue(pending.id, approved)).rejects.toThrow(
			"operation-unavailable",
		);
		await expect(
			agentOperations.complete(
				{ operation: permit.operation },
				"forged receipt",
			),
		).rejects.toThrow("operation-unavailable");
		const toComplete = await agentOperations.admit(
			job.id,
			"receipt-only",
			intent,
		);
		const approvedComplete = await operator.decide(toComplete.id, {
			...decision,
			revision: toComplete.revision,
			digest: toComplete.digest,
			requestId: "approve-receipt",
		});
		const completed = await agentOperations.complete(
			await agentOperations.issue(toComplete.id, approvedComplete),
			"Fixture acknowledgement only; no command was dispatched",
		);
		expect(completed.state).toBe("completed");
		await store.commit(async (tx) => {
			expect(await tx.ownerActive(job.owner)).toBe(true);
			expect(await tx.ownerInfo(job.owner)).toMatchObject({
				id: job.owner,
				repository,
				workspace,
			});
		});
		await expect(
			store.commit(async (tx) => {
				(await tx.doc(EnvironmentState)).stops.mustRollback = "not committed";
				throw new Error("abort changes");
			}),
		).rejects.toThrow("abort changes");
		expect(await store.snapshot(EnvironmentState)).toBeUndefined();
		// Nested persistence calls are refused rather than waiting on themselves.
		await expect(
			store.commit(async () => store.snapshot(EnvironmentState)),
		).rejects.toThrow("controller-store-unavailable");
		await expect(alice.beginClose(job.id, job.revision + 1)).rejects.toThrow(
			"scope-unavailable",
		);
		expect(await alice.beginClose(job.id, job.revision)).toMatchObject({
			state: "closing",
			revision: 2,
		});
		await expect(alice.assertActive(job.id)).rejects.toThrow(
			"scope-unavailable",
		);
		await store.close();
		store = ControllerPersistence.open(state);
		scopes = await ControllerScopes.open(store, [repository]);
		operations = await ControllerOperations.open(store, scopes, async () => {
			throw new Error("Historical retries must not resolve or dispatch");
		});
		agentOperations = operations.bind({ id: "alice", role: "agent" });
		expect(
			await agentOperations.admit(job.id, "start-api", intent),
		).toMatchObject({
			id: pending.id,
			state: "interrupted",
			inspectionRequired: true,
			plan: pending.plan,
		});
		expect(await agentOperations.read(completed.id)).toMatchObject({
			state: "completed",
			result: completed.result,
		});
		await expect(
			agentOperations.issue(pending.id, permit.operation),
		).rejects.toThrow("operation-unavailable");
		await expect(
			agentOperations.complete(permit, "old host receipt"),
		).rejects.toThrow("operation-unavailable");
		alice = scopes.bind({ id: "alice", role: "agent" });
		expect(await alice.read(job.id)).toMatchObject({
			id: job.id,
			state: "interrupted",
		});
		expect(await alice.create(request)).toMatchObject({
			id: job.id,
			state: "interrupted",
		});
		await expect(alice.assertActive(job.id)).rejects.toThrow(
			"scope-unavailable",
		);
		await store.commit(async (tx) => {
			expect(await tx.ownerActive(infrastructure.owner)).toBe(false);
		});
		const fresh = await alice.create({ ...request, requestId: "fresh" });
		expect(fresh.owner).toBeGreaterThan(job.owner);
		expect((await alice.assertActive(fresh.id)).id).toBe(fresh.id);
		fs.renameSync(workspace, path.join(repository, "old-workspace"));
		fs.mkdirSync(workspace);
		await expect(alice.assertActive(fresh.id)).rejects.toThrow(
			"scope-unavailable",
		);
	} finally {
		await store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
