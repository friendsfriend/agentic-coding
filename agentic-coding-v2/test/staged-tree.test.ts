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
