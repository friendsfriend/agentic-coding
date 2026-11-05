import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("an ephemeral staged tree is assembled from saved text, verified, discarded and grants no runtime or publication authority", async () => {
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
	const staging = path.join(config.stateDir, "native", "staging");
	const leftovers = () =>
		fs.existsSync(staging) ? fs.readdirSync(staging) : [];
	try {
		const repository = config.repositories[0] ?? "",
			live = path.join(repository, "compose.yaml"),
			liveText = "invalid-live-tree-source-marker";
		fs.writeFileSync(live, liveText);
		const target = (id: string, file: string) => ({
			id,
			action: "run",
			runtime: "compose",
			compose: {
				file,
				provider: "docker",
				socket: path.join(config.stateDir, "absent.sock"),
			},
		});
		const text = JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository,
						targets: [
							target("stack", "compose.yaml"),
							target("nested", "deploy/stack/compose.yaml"),
						],
					},
				],
			}),
			created = await (
				await api("/api/environments/drafts", {
					requestId: "create",
					content: text,
				})
			).json();
		const route = "/api/environments/drafts/preflight",
			sourceRoute = "/api/environments/drafts/source",
			marker = "private-staged-tree-service-marker",
			content = `services:\n  ${marker}:\n    image: fixture:latest\n    command: [echo, ${marker}]\n`,
			nestedContent = `services:\n  ${marker}-nested:\n    image: fixture:latest\n`,
			check = (requestId: string, revision: number, digest = created.digest) =>
				api(route, {
					requestId,
					id: created.id,
					revision,
					digest,
					materializeStagedTree: true,
				});
		expect(
			(
				await fetch(new URL(route, host.url), {
					method: "POST",
					body: JSON.stringify({
						requestId: "anonymous",
						id: created.id,
						revision: 1,
						digest: created.digest,
						materializeStagedTree: true,
					}),
				})
			).status,
		).toBe(401);
		const body = {
			id: created.id,
			revision: 1,
			digest: created.digest,
			materializeStagedTree: true,
		};
		expect(
			(await api(route, { ...body, requestId: "app", app: "api" })).status,
		).toBe(400);
		expect(
			(
				await api(route, {
					...body,
					requestId: "both",
					validateStagedCandidate: true,
				})
			).status,
		).toBe(400);
		expect(
			(
				await api(route, {
					...body,
					requestId: "false",
					materializeStagedTree: false,
				})
			).status,
		).toBe(400);
		const incomplete = await (await check("incomplete", 1)).json();
		expect(incomplete.accepted).toBe(false);
		expect(incomplete.isolatedTreeChecked).toBe(false);
		expect(incomplete.treeDigest).toBeNull();
		expect(incomplete.entries).toHaveLength(0);
		expect(leftovers()).toHaveLength(0);
		const staged = await (
			await api(sourceRoute, {
				requestId: "stage",
				id: created.id,
				revision: 1,
				app: "api",
				target: "stack",
				content,
			})
		).json();
		expect(staged.revision).toBe(2);
		await api(sourceRoute, {
			requestId: "stage-nested",
			id: created.id,
			revision: 2,
			app: "api",
			target: "nested",
			content: nestedContent,
		});
		const response = await check("assembled", 3);
		expect(response.status).toBe(200);
		const tree = await response.json();
		expect(tree.accepted).toBe(true);
		expect(tree.kind).toBe("staged-tree");
		expect(tree.isolatedTreeChecked).toBe(true);
		expect(tree.treeRetained).toBe(false);
		expect(tree.sourceContentsChecked).toBe(false);
		expect(tree.runtimeChecked).toBe(false);
		expect(tree.baseFreshnessChecked).toBe(false);
		expect(tree.publicationAllowed).toBe(false);
		expect(tree.executionAllowed).toBe(false);
		expect(tree.fileCount).toBe(3);
		expect(tree.entries).toHaveLength(3);
		expect(tree.treeDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(tree.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(tree.bytes).toBe(
			Buffer.byteLength(text) +
				Buffer.byteLength(content) +
				Buffer.byteLength(nestedContent),
		);
		expect(
			tree.entries.every(
				(entry: Record<string, unknown>) =>
					Object.keys(entry).sort().join() === "bytes,digest,pathDigest",
			),
		).toBe(true);
		for (const entry of tree.entries) {
			expect(entry.pathDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(entry.digest).toMatch(/^[a-f0-9]{64}$/);
			expect(entry.bytes).toBeGreaterThan(0);
		}
		const rendered = JSON.stringify(tree);
		expect(rendered).not.toContain(marker);
		expect(rendered).not.toContain("compose.yaml");
		expect(rendered).not.toContain("deploy");
		expect(rendered).not.toContain("environments.json");
		expect(leftovers()).toHaveLength(0);
		await api(sourceRoute, {
			requestId: "restage-same-text",
			id: created.id,
			revision: 3,
			app: "api",
			target: "stack",
			content,
		});
		const stable = await (await check("same-inputs", 4)).json();
		expect(stable.treeDigest).toBe(tree.treeDigest);
		await api(sourceRoute, {
			requestId: "restage-changed-text",
			id: created.id,
			revision: 4,
			app: "api",
			target: "stack",
			content: content.replace("fixture:latest", "fixture:other"),
		});
		const changed = await (await check("changed-inputs", 5)).json();
		expect(changed.accepted).toBe(true);
		expect(changed.treeDigest).not.toBe(tree.treeDigest);
		expect(changed.entries).toHaveLength(3);
		expect(leftovers()).toHaveLength(0);
		expect((await check("stale", 1)).status).toBe(400);
		expect((await check("behind", 4)).status).toBe(400);
		expect(await (await check("assembled", 3)).json()).toEqual(tree);
		expect(fs.readFileSync(live, "utf8")).toBe(liveText);
		expect(fs.existsSync(path.join(repository, "compose.other.yaml"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		const snapshot = await app.snapshot();
		expect(snapshot.tasks).toHaveLength(0);
		expect(snapshot.reviews).toHaveLength(0);
		expect(JSON.stringify(snapshot)).not.toContain(tree.treeDigest);
		host.stop();
		await app.close();
		host = serve(await open());
		expect(leftovers()).toHaveLength(0);
		expect(await (await check("assembled", 3)).json()).toEqual(tree);
		expect(await (await api(`${route}?id=${tree.id}`)).json()).toEqual(tree);
	} finally {
		host.stop();
	}
});
test("promotion of a draft with staged sources requires the verified tree identity of those exact bytes", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
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
		const repository = config.repositories[0] ?? "",
			content = "services:\n  api:\n    image: fixture:latest\n";
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
				content,
			})
		).json();
		const promote = (requestId: string, revision: number, digest: string) =>
			api("/api/environments/drafts/promote", {
				requestId,
				id: created.id,
				revision,
				digest,
				approve: digest,
			});
		const assemble = (requestId: string, revision: number, digest: string) =>
			api("/api/environments/drafts/preflight", {
				requestId,
				id: created.id,
				revision,
				digest,
				materializeStagedTree: true,
			});
		// Saved source text alone is not a promotable artifact.
		const unverified = await promote("no-tree", staged.revision, staged.digest);
		expect(unverified.status).toBe(400);
		expect(await unverified.text()).toContain(
			"Promotion requires a verified staged tree identity",
		);
		const first = await (
			await assemble("tree-1", staged.revision, staged.digest)
		).json();
		expect(first.accepted).toBe(true);
		// A later edit makes the recorded identity stale, not adoptable.
		const edited = await (
			await api("/api/environments/drafts/source", {
				requestId: "restage",
				id: created.id,
				revision: staged.revision,
				app: "api",
				target: "stack",
				content: content.replace("fixture:latest", "fixture:other"),
			})
		).json();
		const stale = await promote("stale", edited.revision, edited.digest);
		expect(stale.status).toBe(400);
		expect(await stale.text()).toContain("Staged tree identity is stale");
		const second = await (
			await assemble("tree-2", edited.revision, edited.digest)
		).json();
		expect(second.accepted).toBe(true);
		expect(second.treeDigest).not.toBe(first.treeDigest);
		const promoted = await (
			await promote("verified", edited.revision, edited.digest)
		).json();
		expect(promoted.outcome).toBe("written");
		expect(promoted.stagedTree).toEqual({
			treeDigest: second.treeDigest,
			fileCount: 2,
			bytes:
				Buffer.byteLength(
					fs.readFileSync(
						path.join(config.configDir, "environments.json"),
						"utf8",
					),
				) +
				Buffer.byteLength(content.replace("fixture:latest", "fixture:other")),
			treeRetained: false,
		});
		// The promotion record is history: it does not retain the tree itself.
		const history = await (
			await api(`/api/environments/drafts/promotion?id=${promoted.id}`)
		).json();
		expect(history.stagedTree.treeDigest).toBe(second.treeDigest);
		expect(
			fs.existsSync(path.join(config.stateDir, "native", "staging"))
				? fs.readdirSync(path.join(config.stateDir, "native", "staging"))
				: [],
		).toHaveLength(0);
	} finally {
		host.stop();
	}
});
test("a retained staged tree is owned by its digest, inspectable, and released by supersession or draft deletion", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get(
			"token",
		),
		api = (route: string, body?: unknown) =>
			fetch(new URL(route, host.url), {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		trees = path.join(config.stateDir, "native", "staging", "trees");
	try {
		const repository = config.repositories[0] ?? "",
			created = await (
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
			).json(),
			stage = (requestId: string, revision: number, content: string) =>
				api("/api/environments/drafts/source", {
					requestId,
					id: created.id,
					revision,
					app: "api",
					target: "stack",
					content,
				}).then((response) => response.json()),
			assemble = (requestId: string, revision: number, digest: string) =>
				api("/api/environments/drafts/preflight", {
					requestId,
					id: created.id,
					revision,
					digest,
					materializeStagedTree: true,
					retainStagedTree: true,
				});
		const content = "services:\n  api:\n    image: retained:latest\n",
			staged = await stage("stage", 1, content);
		// Retaining is a tree-mode option only.
		const refused = await api("/api/environments/drafts/preflight", {
			requestId: "retain-candidate",
			id: created.id,
			revision: staged.revision,
			digest: staged.digest,
			validateStagedCandidate: true,
			retainStagedTree: true,
		});
		expect(refused.status).toBe(400);
		const first = await (
			await assemble("retain-1", staged.revision, staged.digest)
		).json();
		expect(first.treeRetained).toBe(true);
		const retained = path.join(trees, first.treeDigest);
		expect(fs.lstatSync(retained).isDirectory()).toBe(true);
		expect(fs.statSync(retained).mode & 0o777).toBe(0o700);
		const written = path.join(retained, "environments.json");
		expect(fs.statSync(written).mode & 0o777).toBe(0o400);
		expect(fs.readFileSync(path.join(retained, "compose.yaml"), "utf8")).toBe(
			content,
		);
		// The retained directory is inspection history, not a promotion input.
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		// Same-owner reuse still re-verifies bytes instead of refusing all existing trees.
		const refreshed = await (
			await assemble("retain-owned-refresh", staged.revision, staged.digest)
		).json();
		expect(refreshed.accepted).toBe(true);
		expect(refreshed.treeDigest).toBe(first.treeDigest);
		// Equal bytes do not give a different draft ownership of this directory.
		const duplicate = await (
			await api("/api/environments/drafts", {
				requestId: "duplicate",
				content: fs.readFileSync(written, "utf8"),
			})
		).json();
		const duplicateSource = await (
			await api("/api/environments/drafts/source", {
				requestId: "duplicate-source",
				id: duplicate.id,
				revision: duplicate.revision,
				app: "api",
				target: "stack",
				content,
			})
		).json();
		const shared = await api("/api/environments/drafts/preflight", {
			requestId: "duplicate-retain",
			id: duplicate.id,
			revision: duplicateSource.revision,
			digest: duplicateSource.digest,
			materializeStagedTree: true,
			retainStagedTree: true,
		});
		expect(shared.status).toBe(400);
		expect(await shared.text()).toContain("owned by another draft");
		// Fresh assembly cannot adopt a modified directory merely by its name.
		const sourceFile = path.join(retained, "compose.yaml");
		fs.chmodSync(sourceFile, 0o600);
		fs.writeFileSync(sourceFile, "changed outside the draft");
		const mismatched = await (
			await assemble("retain-tampered", staged.revision, staged.digest)
		).json();
		expect(mismatched.accepted).toBe(false);
		expect(mismatched.treeRetained).toBe(false);
		expect(fs.readFileSync(sourceFile, "utf8")).toBe(
			"changed outside the draft",
		);
		// A superseding verified tree replaces it by digest.
		const edited = await stage(
			"restage",
			staged.revision,
			content.replace("retained:latest", "retained:next"),
		);
		const second = await (
			await assemble("retain-2", edited.revision, edited.digest)
		).json();
		expect(second.treeDigest).not.toBe(first.treeDigest);
		expect(fs.existsSync(retained)).toBe(false);
		expect(fs.readdirSync(trees)).toEqual([second.treeDigest]);
		const cleanupHistory = await (
			await api("/api/environments/drafts/trees")
		).json();
		expect(cleanupHistory.cleanupAttempts).toContainEqual({
			id: expect.any(String),
			name: first.treeDigest,
			kind: "supersede",
			revision: 2,
			status: "completed",
			startedAt: expect.any(String),
		});
		expect(
			await (await assemble("retain-2", edited.revision, edited.digest)).json(),
		).toEqual(second);
		expect(fs.readdirSync(trees)).toEqual([second.treeDigest]);
		// Draft deletion releases the tree it owns and nothing else.
		const removed = await api("/api/environments/drafts/remove", {
			requestId: "remove",
			id: created.id,
			revision: edited.revision,
		});
		expect(removed.status).toBe(200);
		expect(fs.readdirSync(trees)).toEqual([]);
	} finally {
		host.stop();
	}
});
test("a retained tree is disclosed by metadata and released by its digest without deleting its draft", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	let host = serve(app),
		running = app;
	const reopen = async () => {
		host.stop();
		await running.close();
		running = await open();
		host = serve(running);
	};
	const api = (route: string, body?: unknown) =>
			fetch(new URL(route, host.url), {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		trees = path.join(config.stateDir, "native", "staging", "trees");
	try {
		const repository = config.repositories[0] ?? "",
			created = await (
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
			).json(),
			staged = await (
				await api("/api/environments/drafts/source", {
					requestId: "stage",
					id: created.id,
					revision: 1,
					app: "api",
					target: "stack",
					content: "services:\n  api:\n    image: inspect:latest\n",
				})
			).json(),
			tree = await (
				await api("/api/environments/drafts/preflight", {
					requestId: "retain",
					id: created.id,
					revision: staged.revision,
					digest: staged.digest,
					materializeStagedTree: true,
					retainStagedTree: true,
				})
			).json();
		const listed = await (await api("/api/environments/drafts/trees")).json();
		expect(listed.unowned).toEqual([]);
		expect(listed.trees).toEqual([
			{
				draftId: created.id,
				revision: staged.revision,
				digest: staged.digest,
				name: tree.treeDigest,
				treeDigest: tree.treeDigest,
				fileCount: 2,
				bytes: expect.any(Number),
				retainedAt: expect.any(String),
				present: true,
			},
		]);
		// Nothing is disclosed that would read the tree or its source text.
		expect(JSON.stringify(listed)).not.toContain("inspect:latest");
		// A byte-identical directory without a durable claim must not be adopted.
		const orphanCopy = path.join(config.stateDir, "unowned-tree-copy");
		fs.cpSync(path.join(trees, tree.treeDigest), orphanCopy, {
			recursive: true,
		});
		const release = (requestId: string, name: string) =>
			api("/api/environments/drafts/tree/release", { requestId, name });
		expect((await release("unknown", "a".repeat(64))).status).toBe(400);
		const released = await (await release("release", tree.treeDigest)).json();
		expect(released).toEqual({
			name: tree.treeDigest,
			released: true,
			owner: created.id,
			revision: staged.revision,
		});
		expect(fs.readdirSync(trees)).toEqual([]);
		fs.renameSync(orphanCopy, path.join(trees, tree.treeDigest));
		await reopen();
		const orphanMetadata = await (
			await api("/api/environments/drafts/trees")
		).json();
		expect(orphanMetadata.trees).toEqual([]);
		expect(orphanMetadata.unowned).toEqual([tree.treeDigest]);
		expect(JSON.stringify(orphanMetadata)).not.toContain("inspect:latest");
		const retainOrphan = (requestId: string) =>
			api("/api/environments/drafts/preflight", {
				requestId,
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				materializeStagedTree: true,
				retainStagedTree: true,
			});
		const refusedOrphan = await retainOrphan("retain-unowned");
		expect(refusedOrphan.status).toBe(400);
		expect(await refusedOrphan.text()).toContain("cannot be adopted");
		expect((await retainOrphan("retain-unowned")).status).toBe(400);
		expect((await retainOrphan("fresh-retain-unowned")).status).toBe(400);
		const unclaimedDraft = await (
			await api(`/api/environments/drafts?id=${created.id}`)
		).json();
		expect(unclaimedDraft.stagedTree.retained).toBeNull();
		expect(unclaimedDraft.stagedTree.current).toBe(true);
		const ephemeralWithOrphan = await (
			await api("/api/environments/drafts/preflight", {
				requestId: "ephemeral-with-orphan",
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				materializeStagedTree: true,
			})
		).json();
		expect(ephemeralWithOrphan.accepted).toBe(true);
		expect(ephemeralWithOrphan.treeRetained).toBe(false);
		expect(fs.existsSync(path.join(trees, tree.treeDigest))).toBe(true);
		// Even a successful historical retention preflight cannot backfill ownership.
		expect(
			await (
				await api("/api/environments/drafts/preflight", {
					requestId: "retain",
					id: created.id,
					revision: staged.revision,
					digest: staged.digest,
					materializeStagedTree: true,
					retainStagedTree: true,
				})
			).json(),
		).toEqual(tree);
		expect(
			(await (await api("/api/environments/drafts/trees")).json()).trees,
		).toEqual([]);
		expect(await (await release("release", tree.treeDigest)).json()).toEqual(
			released,
		);
		expect(fs.existsSync(path.join(trees, tree.treeDigest))).toBe(true);
		expect(
			(await (await release("release-unowned-copy", tree.treeDigest)).json())
				.owner,
		).toBeNull();
		expect(fs.readdirSync(trees)).toEqual([]);
		// The exact request replays its historical outcome and dispatches nothing.
		expect(await (await release("release", tree.treeDigest)).json()).toEqual(
			released,
		);
		const after = await (await api("/api/environments/drafts/trees")).json();
		expect(after.trees).toEqual([]);
		expect(after.unowned).toEqual([]);
		// The draft survives with its revision and still-promotable identity.
		const draft = await (
			await api(`/api/environments/drafts?id=${created.id}`)
		).json();
		expect(draft.revision).toBe(staged.revision);
		const promoted = await (
			await api("/api/environments/drafts/promote", {
				requestId: "promote",
				id: created.id,
				revision: staged.revision,
				digest: staged.digest,
				approve: staged.digest,
			})
		).json();
		expect(promoted.outcome).toBe("written");
		expect(promoted.stagedTree.treeRetained).toBe(false);
		// A directory no record owns is disclosed and can still be released.
		fs.mkdirSync(path.join(trees, "b".repeat(64)), { mode: 0o700 });
		expect(
			(await (await api("/api/environments/drafts/trees")).json()).unowned,
		).toEqual(["b".repeat(64)]);
		expect(await (await release("orphan", "b".repeat(64))).json()).toEqual({
			name: "b".repeat(64),
			released: true,
			owner: null,
			revision: null,
		});
		expect(fs.readdirSync(trees)).toEqual([]);
		// A failed effect leaves a durable uncertainty fence, not a retry grant.
		await api("/api/environments/drafts/preflight", {
			requestId: "retain-again",
			id: created.id,
			revision: staged.revision,
			digest: staged.digest,
			materializeStagedTree: true,
			retainStagedTree: true,
		});
		const held = path.join(trees, tree.treeDigest),
			parked = path.join(config.stateDir, "parked-tree");
		expect(await (await release("release", tree.treeDigest)).json()).toEqual(
			released,
		);
		expect(fs.existsSync(held)).toBe(true);
		fs.renameSync(held, parked);
		fs.symlinkSync(parked, held);
		expect((await release("uncertain", tree.treeDigest)).status).toBe(400);
		fs.unlinkSync(held);
		fs.renameSync(parked, held);
		// Restoring the directory is not evidence that the effect never issued.
		const retry = await release("uncertain", tree.treeDigest);
		expect(retry.status).toBe(400);
		expect(await retry.text()).toContain("automatic retry is forbidden");
		expect(
			(await release("fresh-after-uncertain", tree.treeDigest)).status,
		).toBe(400);
		const blocked = await api("/api/environments/drafts/preflight", {
			requestId: "blocked-assembly",
			id: created.id,
			revision: staged.revision,
			digest: staged.digest,
			materializeStagedTree: true,
			retainStagedTree: true,
		});
		expect(blocked.status).toBe(400);
		expect(fs.existsSync(held)).toBe(true);
		const uncertain = await (
			await api("/api/environments/drafts/trees")
		).json();
		expect(
			uncertain.cleanupAttempts.some(
				(attempt: { status: string }) => attempt.status === "pending",
			),
		).toBe(true);
		expect(
			(
				await api("/api/environments/drafts/remove", {
					requestId: "delete-after-uncertain",
					id: created.id,
					revision: staged.revision,
				})
			).status,
		).toBe(400);
		// A normal host reopen must preserve uncertainty without issuing cleanup.
		await reopen();
		expect(
			(await (await api("/api/environments/drafts/trees")).json())
				.cleanupAttempts,
		).toEqual(uncertain.cleanupAttempts);
		expect((await release("uncertain", tree.treeDigest)).status).toBe(400);
		expect(fs.existsSync(held)).toBe(true);
		const pending = uncertain.cleanupAttempts.find(
				(attempt: { status: string }) => attempt.status === "pending",
			),
			ack = (requestId: string, revision: number) =>
				api("/api/environments/drafts/tree-cleanup/acknowledge", {
					requestId,
					id: pending.id,
					revision,
					acknowledge: true,
				});
		expect((await ack("stale-ack", pending.revision + 1)).status).toBe(400);
		const acknowledged = await (await ack("ack", pending.revision)).json();
		expect(acknowledged).toEqual({
			id: pending.id,
			revision: pending.revision + 1,
			status: "acknowledged",
		});
		expect(fs.existsSync(held)).toBe(true);
		expect(await (await ack("ack", pending.revision)).json()).toEqual(
			acknowledged,
		);
		expect((await ack("ack", pending.revision + 1)).status).toBe(400);
		// Acknowledgement retires the blocker, not the failed deletion request.
		expect((await release("uncertain", tree.treeDigest)).status).toBe(400);
		expect(
			(await api(`/api/environments/drafts?id=${created.id}`)).status,
		).toBe(200);
		const freshRelease = await (
			await release("after-ack", tree.treeDigest)
		).json();
		expect(freshRelease.released).toBe(true);
		expect(fs.existsSync(held)).toBe(false);
		await reopen();
		expect(
			(await (await api("/api/environments/drafts/trees")).json()).trees,
		).toEqual([]);
		expect(await (await ack("ack", pending.revision)).json()).toEqual(
			acknowledged,
		);
		// An old acknowledgement must not retire a later pending attempt, even after reopen.
		expect(
			(
				await api("/api/environments/drafts/preflight", {
					requestId: "retain-after-ack",
					id: created.id,
					revision: staged.revision,
					digest: staged.digest,
					materializeStagedTree: true,
					retainStagedTree: true,
				})
			).status,
		).toBe(200);
		fs.renameSync(held, parked);
		fs.symlinkSync(parked, held);
		expect((await release("second-uncertain", tree.treeDigest)).status).toBe(
			400,
		);
		fs.unlinkSync(held);
		fs.renameSync(parked, held);
		await reopen();
		expect(await (await ack("ack", pending.revision)).json()).toEqual(
			acknowledged,
		);
		expect((await release("fresh-after-old-ack", tree.treeDigest)).status).toBe(
			400,
		);
		const later = await (await api("/api/environments/drafts/trees")).json();
		expect(
			later.cleanupAttempts.filter(
				(attempt: { status: string }) => attempt.status === "pending",
			),
		).toHaveLength(1);
		expect(fs.existsSync(held)).toBe(true);
	} finally {
		host.stop();
	}
});
test("a draft read discloses whether its recorded tree identity is current and retained", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get(
			"token",
		),
		api = (route: string, body?: unknown) =>
			fetch(new URL(route, host.url), {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		read = async () =>
			(
				await api(
					`/api/environments/drafts?id=${encodeURIComponent(created.id)}`,
				)
			).json();
	let created: { id: string };
	try {
		const repository = config.repositories[0] ?? "";
		created = await (
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
		expect((await read()).stagedTree).toBe(null);
		const staged = await (
			await api("/api/environments/drafts/source", {
				requestId: "stage",
				id: created.id,
				revision: 1,
				app: "api",
				target: "stack",
				content: "services:\n  api:\n    image: read:latest\n",
			})
		).json();
		await api("/api/environments/drafts/preflight", {
			requestId: "retain",
			id: created.id,
			revision: staged.revision,
			digest: staged.digest,
			materializeStagedTree: true,
			retainStagedTree: true,
		});
		const current = await read();
		expect(current.stagedTree).toEqual({
			revision: staged.revision,
			digest: staged.digest,
			treeDigest: current.stagedTree.treeDigest,
			fileCount: 2,
			bytes: expect.any(Number),
			observedAt: expect.any(String),
			current: true,
			retained: {
				name: current.stagedTree.treeDigest,
				retainedAt: expect.any(String),
				present: true,
			},
		});
		// An edit makes the recorded identity visible as stale rather than absent.
		const edited = await (
			await api("/api/environments/drafts/source", {
				requestId: "restage",
				id: created.id,
				revision: staged.revision,
				app: "api",
				target: "stack",
				content: "services:\n  api:\n    image: read:other\n",
			})
		).json();
		const stale = await read();
		expect(stale.revision).toBe(edited.revision);
		expect(stale.stagedTree.current).toBe(false);
		expect(stale.stagedTree.digest).toBe(staged.digest);
		// Supersession must journal uncertainty before deleting the old tree.
		const held = path.join(
				config.stateDir,
				"native",
				"staging",
				"trees",
				current.stagedTree.treeDigest,
			),
			parked = path.join(config.stateDir, "old-tree");
		fs.renameSync(held, parked);
		fs.symlinkSync(parked, held);
		const supersede = (requestId: string) =>
			api("/api/environments/drafts/preflight", {
				requestId,
				id: created.id,
				revision: edited.revision,
				digest: edited.digest,
				materializeStagedTree: true,
				retainStagedTree: true,
			});
		expect((await supersede("failed-supersession")).status).toBe(400);
		const history = await (await api("/api/environments/drafts/trees")).json();
		expect(history.cleanupAttempts).toContainEqual({
			id: expect.any(String),
			name: current.stagedTree.treeDigest,
			kind: "supersede",
			revision: 1,
			status: "pending",
			startedAt: expect.any(String),
		});
		expect((await read()).stagedTree).toEqual({
			...stale.stagedTree,
			retained: { ...stale.stagedTree.retained, present: false },
		});
		fs.unlinkSync(held);
		fs.renameSync(parked, held);
		expect((await supersede("failed-supersession")).status).toBe(400);
		expect((await supersede("fresh-supersession")).status).toBe(400);
		expect(fs.existsSync(held)).toBe(true);
		// The new directory was created before the failed old-tree deletion. Its name
		// and exact bytes cannot turn that failed preflight into a retention claim.
		expect(history.unowned).toHaveLength(1);
		const orphanName = history.unowned[0],
			pending = history.cleanupAttempts.find(
				(entry: { status: string }) => entry.status === "pending",
			);
		expect(
			(
				await api("/api/environments/drafts/tree-cleanup/acknowledge", {
					requestId: "ack-supersession",
					id: pending.id,
					revision: pending.revision,
					acknowledge: true,
				})
			).status,
		).toBe(200);
		const unownedRetry = await supersede("fresh-after-supersession-ack");
		expect(unownedRetry.status).toBe(400);
		expect(await unownedRetry.text()).toContain("cannot be adopted");
		expect((await read()).stagedTree.current).toBe(false);
		const orphanReleased = await (
			await api("/api/environments/drafts/tree/release", {
				requestId: "release-supersession-orphan",
				name: orphanName,
			})
		).json();
		expect(orphanReleased.owner).toBeNull();
		expect(fs.existsSync(held)).toBe(true);
		const recovered = await (
			await supersede("supersession-after-explicit-release")
		).json();
		expect(recovered.accepted).toBe(true);
		expect((await read()).stagedTree.current).toBe(true);
		expect(fs.existsSync(held)).toBe(false);
	} finally {
		host.stop();
	}
});
