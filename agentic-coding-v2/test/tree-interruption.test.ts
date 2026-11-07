import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test.each([
	{ supersession: false, phase: "rename" },
	{ supersession: true, phase: "rename" },
	{ supersession: false, phase: "write" },
])(
	"interrupted tree creation and explicit recovery (%j)",
	async ({ supersession, phase }) => {
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
			const created = await (
				await api("/api/environments/drafts", {
					requestId: "create",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "app",
								repository: config.repositories[0],
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
			const stage = (requestId: string, revision: number, image: string) =>
				api("/api/environments/drafts/source", {
					requestId,
					id: created.id,
					revision,
					app: "api",
					target: "stack",
					content: `services:\n  api:\n    image: ${image}:latest\n`,
				});
			let staged = await (
				await stage("source", created.revision, "initial")
			).json();
			let previousName: string | null = null;
			if (supersession) {
				const first = await (
					await api("/api/environments/drafts/preflight", {
						requestId: "initial-tree",
						id: created.id,
						revision: staged.revision,
						digest: staged.digest,
						materializeStagedTree: true,
						retainStagedTree: true,
					})
				).json();
				expect(first.accepted).toBe(true);
				previousName = first.treeDigest;
				staged = await (
					await stage("changed-source", staged.revision, "changed")
				).json();
			}
			const body = {
				requestId: "interrupted-tree",
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				materializeStagedTree: true,
				retainStagedTree: true,
			};
			host.stop();
			await app.close();
			const input = path.join(config.stateDir, "tree-interruption.json");
			fs.writeFileSync(input, JSON.stringify({ config, body, phase }));
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "fixtures/tree-interruption.ts"),
					input,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
			try {
				await child.exited;
			} finally {
				clearTimeout(deadline);
			}
			expect(child.signalCode).toBe("SIGKILL");
			host = serve(await open());
			const history = await (
				await api("/api/environments/drafts/trees")
			).json();
			const pending = history.cleanupAttempts.find(
				(attempt: { status: string }) => attempt.status === "pending",
			);
			expect(pending).toMatchObject({
				kind: "assemble",
				assembly: {
					draftId: created.id,
					draftRevision: staged.revision,
					contentDigest: staged.digest,
					previousName,
					retain: true,
				},
			});
			const trees = path.join(config.stateDir, "native/staging/trees");
			expect(fs.existsSync(path.join(trees, pending.assembly.treeDigest))).toBe(
				phase === "rename",
			);
			if (phase === "write") {
				expect(pending.temporary.state).toBe("present");
				expect(
					(
						await api("/api/environments/drafts/tree/temporary-release", {
							requestId: "before-ack",
							id: pending.id,
							revision: pending.revision,
							fingerprint: pending.temporary.fingerprint,
							remove: true,
						})
					).status,
				).toBe(400);
			}
			if (previousName)
				expect(fs.existsSync(path.join(trees, previousName))).toBe(true);
			const before = fs.readdirSync(trees).sort();
			expect(
				(await api("/api/environments/drafts/preflight", body)).status,
			).toBe(400);
			expect(
				(
					await api("/api/environments/drafts/preflight", {
						...body,
						requestId: "fresh-before-inspection",
					})
				).status,
			).toBe(400);
			expect(fs.readdirSync(trees).sort()).toEqual(before);
			expect(
				(
					await api("/api/environments/drafts/tree-cleanup/acknowledge", {
						requestId: "ack",
						id: pending.id,
						revision: pending.revision,
						acknowledge: true,
					})
				).status,
			).toBe(200);
			expect(
				(await api("/api/environments/drafts/preflight", body)).status,
			).toBe(400);
			expect(fs.readdirSync(trees).sort()).toEqual(before);
			if (phase === "write") {
				const temporary = path.join(
						config.stateDir,
						"native/staging",
						pending.assembly.temporaryName,
					),
					parked = `${temporary}-parked`,
					unrelated = path.join(
						config.stateDir,
						"native/staging",
						`tree-${"b".repeat(64)}`,
					);
				fs.mkdirSync(unrelated, { mode: 0o700 });
				const releaseBody = {
					requestId: "temporary-cleanup",
					id: pending.id,
					revision: pending.revision + 1,
					fingerprint: pending.temporary.fingerprint,
					remove: true,
				};
				fs.renameSync(temporary, parked);
				fs.symlinkSync(parked, temporary);
				expect(
					(
						await api(
							"/api/environments/drafts/tree/temporary-release",
							releaseBody,
						)
					).status,
				).toBe(400);
				expect(fs.existsSync(path.join(parked, "environments.json"))).toBe(
					true,
				);
				fs.unlinkSync(temporary);
				fs.renameSync(parked, temporary);
				expect(
					(
						await api(
							"/api/environments/drafts/tree/temporary-release",
							releaseBody,
						)
					).status,
				).toBe(400);
				const freshHistory = await (
					await api("/api/environments/drafts/trees")
				).json();
				const freshObservation = freshHistory.cleanupAttempts.find(
					(attempt: { id: string }) => attempt.id === pending.id,
				).temporary;
				const exact = {
					...releaseBody,
					fingerprint: freshObservation.fingerprint,
				};
				const response = await api(
					"/api/environments/drafts/tree/temporary-release",
					exact,
				);
				expect(response.status).toBe(200);
				const removed = await response.json();
				expect(removed.removed).toBe(true);
				expect(fs.existsSync(temporary)).toBe(false);
				fs.mkdirSync(temporary, { mode: 0o700 });
				expect(
					await (
						await api("/api/environments/drafts/tree/temporary-release", exact)
					).json(),
				).toEqual(removed);
				expect(fs.existsSync(temporary)).toBe(true);
				expect(fs.existsSync(unrelated)).toBe(true);
			} else {
				const released = await (
					await api("/api/environments/drafts/tree/release", {
						requestId: "release-orphan",
						name: pending.assembly.treeDigest,
					})
				).json();
				expect(released).toMatchObject({ released: true, owner: null });
			}
			if (previousName)
				expect(fs.existsSync(path.join(trees, previousName))).toBe(true);
			const recovered = await (
				await api("/api/environments/drafts/preflight", {
					...body,
					requestId: "fresh-after-inspection",
				})
			).json();
			expect(recovered.accepted).toBe(true);
			expect(recovered.treeDigest).toBe(pending.assembly.treeDigest);
		} finally {
			host.stop();
		}
	},
	20000,
);
