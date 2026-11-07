import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("an uncertain retained-tree deletion blocks replay and reassembly until explicit acknowledgement, which retires the blocker without granting retry", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	const token = () =>
		new URLSearchParams(new URL(host.url).hash.slice(1)).get("token") ?? "";
	const api = (route: string, body?: unknown) =>
		fetch(new URL(route, host.url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token()}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	try {
		const repository = config.repositories[0] ?? "",
			target = (file: string) => ({
				id: "stack",
				action: "run",
				runtime: "compose",
				compose: {
					file,
					provider: "docker",
					socket: path.join(config.stateDir, "absent.sock"),
				},
			}),
			definition = () => ({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository,
						targets: [target("compose.yaml")],
					},
				],
			}),
			content = (image: string) => `services:\n  api:\n    image: ${image}\n`;
		const create = (requestId: string) =>
			api("/api/environments/drafts", {
				requestId,
				content: JSON.stringify(definition()),
			}).then((response) => response.json());
		const created = await create("create");
		const staged = await (
			await api("/api/environments/drafts/source", {
				requestId: "stage",
				id: created.id,
				revision: 1,
				app: "api",
				target: "stack",
				content: content("retained:latest"),
			})
		).json();
		const assembled = await (
			await api("/api/environments/drafts/preflight", {
				requestId: "retain",
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				materializeStagedTree: true,
				retainStagedTree: true,
			})
		).json();
		expect(assembled.treeRetained).toBe(true);
		const trees = path.join(config.stateDir, "native", "staging", "trees"),
			retained = path.join(trees, assembled.treeDigest);
		expect(fs.lstatSync(retained).isDirectory()).toBe(true);
		// Operator sabotage after the pending marker commits is durably identical
		// to a crash after admission: the effect refuses the replaced root, so
		// the attempt stays pending with uncertain effects.
		const decoy = path.join(config.stateDir, "sabotage-target");
		fs.mkdirSync(decoy);
		fs.writeFileSync(path.join(decoy, "marker"), "untouched");
		fs.rmSync(retained, { recursive: true });
		fs.symlinkSync(decoy, retained);
		const removal = { requestId: "remove-1", id: created.id, revision: 2 };
		const failed = await api("/api/environments/drafts/remove", removal);
		expect(failed.status).toBe(400);
		expect(fs.readFileSync(path.join(decoy, "marker"), "utf8")).toBe(
			"untouched",
		);
		expect(fs.lstatSync(retained).isSymbolicLink()).toBe(true);
		const pending = await (await api("/api/environments/drafts/trees")).json();
		const attempt = pending.cleanupAttempts.find(
			(attempt: { kind: string }) => attempt.kind === "delete-draft",
		);
		expect(attempt?.status).toBe("pending");
		// The same request is never replayed while its outcome is unresolved.
		expect((await api("/api/environments/drafts/remove", removal)).status).toBe(
			400,
		);
		// Unresolved cleanup blocks new tree assembly on any draft.
		const blocked = await api("/api/environments/drafts/preflight", {
			requestId: "blocked",
			id: created.id,
			revision: 2,
			digest: created.digest,
			materializeStagedTree: true,
		});
		expect(blocked.status).toBe(400);
		// A reopened host observes the same pending attempt, not a recovery.
		const restored = await open();
		const reopened = serve(restored);
		try {
			const reopenedApi = (route: string, body?: unknown) =>
				fetch(new URL(route, reopened.url), {
					method: body === undefined ? "GET" : "POST",
					headers: {
						Authorization: `Bearer ${new URLSearchParams(new URL(reopened.url).hash.slice(1)).get("token")}`,
						"Content-Type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			const afterReopen = await (
				await reopenedApi("/api/environments/drafts/trees")
			).json();
			expect(
				afterReopen.cleanupAttempts.find(
					(entry: { kind: string }) => entry.kind === "delete-draft",
				)?.status,
			).toBe("pending");
			expect(
				(await reopenedApi("/api/environments/drafts/remove", removal)).status,
			).toBe(400);
			// Explicit acknowledgement retires the uncertainty blocker. It grants
			// no retry: the same request still cannot run, but other drafts are
			// no longer fenced by this attempt.
			const acknowledged = await (
				await reopenedApi("/api/environments/drafts/tree-cleanup/acknowledge", {
					requestId: "ack-1",
					id: attempt.id,
					revision: 1,
					acknowledge: true,
				})
			).json();
			expect(acknowledged).toMatchObject({ status: "acknowledged" });
			expect(
				(await reopenedApi("/api/environments/drafts/remove", removal)).status,
			).toBe(400);
			const retired = await (
				await reopenedApi("/api/environments/drafts/trees")
			).json();
			expect(
				retired.cleanupAttempts.find(
					(entry: { kind: string }) => entry.kind === "delete-draft",
				)?.status,
			).toBe("acknowledged");
		} finally {
			await reopened.stop();
		}
	} finally {
		await host.stop();
	}
}, 60000);
