import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test.each([{ removal: "before-removal" }, { removal: "after-removal" }])(
	"crash during temporary-tree deletion leaves a pending intent that blocks replay until acknowledgement (%j)",
	async ({ removal }) => {
		const { app, config, open } = await fixture(true, (config) => {
			fs.chmodSync(config.stateDir, 0o700);
			fs.mkdirSync(config.configDir, { mode: 0o700 });
		});
		let host = serve(app);
		const api = (route: string, body?: unknown) =>
			fetch(new URL(route, host.url), {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		try {
			const repository = config.repositories[0] ?? "";
			const created = await (
				await api("/api/environments/drafts", {
					requestId: "create",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "app",
								repository,
								targets: [
									{
										id: "stack",
										action: "run",
										runtime: "compose",
										compose: {
											file: "compose.yaml",
											provider: "docker",
											socket: path.join(config.stateDir, "absent.sock"),
										},
									},
								],
							},
						],
					}),
				})
			).json();
			const staged = await (
				await api("/api/environments/drafts/source", {
					requestId: "stage",
					id: created.id,
					revision: 1,
					app: "api",
					target: "stack",
					content: "services:\n  api:\n    image: doomed:latest\n",
				})
			).json();
			const preflightBody = {
				requestId: "interrupted-tree",
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				materializeStagedTree: true,
			};
			host.stop();
			await app.close();
			// First crash: die writing the temporary tree, leaving a pending
			// assemble intent with a partial exclusive tree.
			const crashInput = path.join(config.stateDir, "tree-release-crash.json");
			fs.writeFileSync(
				crashInput,
				JSON.stringify({ config, body: preflightBody, phase: "write" }),
			);
			const crashed = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "fixtures/tree-interruption.ts"),
					crashInput,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const crashDeadline = setTimeout(() => crashed.kill("SIGKILL"), 10000);
			try {
				await crashed.exited;
			} finally {
				clearTimeout(crashDeadline);
			}
			expect(crashed.signalCode).toBe("SIGKILL");
			const reopened = await open();
			host = serve(reopened);
			const history = await (
				await api("/api/environments/drafts/trees")
			).json();
			const interrupted = history.cleanupAttempts.find(
				(attempt: { kind: string; status: string }) =>
					attempt.kind === "assemble" && attempt.status === "pending",
			);
			expect(interrupted.assembly.temporaryName).toMatch(/^tree-[a-f0-9]{64}$/);
			expect(interrupted.temporary.state).toBe("present");
			const temporary = path.join(
				config.stateDir,
				"native/staging",
				interrupted.assembly.temporaryName,
			);
			expect(fs.existsSync(temporary)).toBe(true);
			expect(
				(
					await api("/api/environments/drafts/tree-cleanup/acknowledge", {
						requestId: "ack-assemble",
						id: interrupted.id,
						revision: interrupted.revision,
						acknowledge: true,
					})
				).status,
			).toBe(200);
			const admitted = await (
				await api("/api/environments/drafts/trees")
			).json();
			const assembly = admitted.cleanupAttempts.find(
				(attempt: { id: string }) => attempt.id === interrupted.id,
			);
			expect(assembly.status).toBe("acknowledged");
			host.stop();
			await reopened.close();
			// Second crash: die inside the temporary-tree deletion itself, after
			// the deletion intent commits and before its completion is recorded.
			const releaseBody = {
				requestId: "temporary-release",
				id: interrupted.id,
				revision: assembly.revision,
				fingerprint: interrupted.temporary.fingerprint,
				remove: true,
			};
			const releaseInput = path.join(
				config.stateDir,
				"tree-release-deletion.json",
			);
			fs.writeFileSync(
				releaseInput,
				JSON.stringify({ config, body: releaseBody, phase: removal }),
			);
			const killed = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "fixtures/tree-release-interruption.ts"),
					releaseInput,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const killDeadline = setTimeout(() => killed.kill("SIGKILL"), 10000);
			try {
				await killed.exited;
			} finally {
				clearTimeout(killDeadline);
			}
			expect(killed.signalCode).toBe("SIGKILL");
			host = serve(await open());
			const after = await (await api("/api/environments/drafts/trees")).json();
			const release = after.cleanupAttempts.find(
				(attempt: { kind: string }) => attempt.kind === "temporary-release",
			);
			expect(release).toMatchObject({ status: "pending" });
			expect(fs.existsSync(temporary)).toBe(removal === "before-removal");
			// The same deletion request is never replayed while its outcome is
			// unresolved, and fresh assembly stays blocked.
			const replay = await api(
				"/api/environments/drafts/tree/temporary-release",
				releaseBody,
			);
			expect(replay.status).toBe(400);
			expect(await replay.text()).toContain("automatic retry is forbidden");
			const blocked = await api("/api/environments/drafts/preflight", {
				...preflightBody,
				requestId: "blocked-after-crash",
			});
			expect(blocked.status).toBe(400);
			expect(await blocked.text()).toContain("blocks tree assembly");
			// Explicit acknowledgement retires the uncertainty blocker without
			// granting retry of the crashed deletion.
			const retired = await (
				await api("/api/environments/drafts/tree-cleanup/acknowledge", {
					requestId: "ack-release",
					id: release.id,
					revision: release.revision,
					acknowledge: true,
				})
			).json();
			expect(retired).toMatchObject({ status: "acknowledged" });
			expect(
				(
					await api(
						"/api/environments/drafts/tree/temporary-release",
						releaseBody,
					)
				).status,
			).toBe(400);
			if (removal === "before-removal") {
				// The killed deletion attempt re-pinned directory modes before
				// dying, so the stale fingerprint no longer matches: the retry
				// must carry the currently observed identity, and then it
				// completes the deletion.
				const current = await (
					await api("/api/environments/drafts/trees")
				).json();
				const currentFingerprint = current.cleanupAttempts.find(
					(attempt: { id: string }) => attempt.id === interrupted.id,
				).temporary.fingerprint;
				expect(currentFingerprint).not.toBe(releaseBody.fingerprint);
				const fresh = await api(
					"/api/environments/drafts/tree/temporary-release",
					{
						...releaseBody,
						requestId: "temporary-release-retry",
						fingerprint: currentFingerprint,
					},
				);
				expect(fresh.status).toBe(200);
				expect((await fresh.json()).removed).toBe(true);
				expect(fs.existsSync(temporary)).toBe(false);
			} else {
				// The tree is already gone; a fresh request fails closed instead
				// of deleting anything else.
				const gone = await api(
					"/api/environments/drafts/tree/temporary-release",
					{ ...releaseBody, requestId: "temporary-release-retry" },
				);
				expect(gone.status).toBe(400);
				expect(await gone.text()).toContain(
					"identity changed or is unavailable",
				);
			}
			const recovered = await (
				await api("/api/environments/drafts/preflight", {
					...preflightBody,
					requestId: "recovered-assembly",
				})
			).json();
			expect(recovered.accepted).toBe(true);
		} finally {
			host.stop();
		}
	},
	60000,
);
