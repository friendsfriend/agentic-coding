import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("explicit private staged-source and draft removal is revision-fenced, idempotent, keeps history and never touches repositories or live configuration", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	let host = serve(app);
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
			live = path.join(repository, "compose.yaml"),
			liveText = "invalid-live-removal-source-marker";
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
		const definition = {
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository,
					targets: [target("first", "compose.yaml")],
				},
			],
		};
		const created = await (
			await api("/api/environments/drafts", {
				requestId: "create",
				content: JSON.stringify(definition),
			})
		).json();
		const sourceRoute = "/api/environments/drafts/source",
			sourceRemoval = `${sourceRoute}/remove`,
			draftRemoval = "/api/environments/drafts/remove",
			checkRoute = "/api/environments/drafts/preflight",
			stage = (requestId: string, revision: number, targetId: string) =>
				api(sourceRoute, {
					requestId,
					id: created.id,
					revision,
					app: "api",
					target: targetId,
					content: `services:\n  removal-fixture:\n    image: fixture:latest\n`,
				}),
			removeSource = (requestId: string, revision: number) =>
				api(sourceRemoval, {
					requestId,
					id: created.id,
					revision,
					app: "api",
					target: "first",
				}),
			candidate = (requestId: string, revision: number) =>
				api(checkRoute, {
					requestId,
					id: created.id,
					revision,
					digest: created.digest,
					validateStagedCandidate: true,
				});
		expect(
			(
				await fetch(new URL(sourceRemoval, host.url), {
					method: "POST",
					body: JSON.stringify({ id: created.id, revision: 1 }),
				})
			).status,
		).toBe(401);
		expect(
			(
				await api(sourceRemoval, {
					requestId: "unknown-field",
					id: created.id,
					revision: 1,
					app: "api",
					target: "first",
					content: "x",
				})
			).status,
		).toBe(400);
		expect((await removeSource("absent", 1)).status).toBe(400);
		await stage("stage", 1, "first");
		const candidateBefore = await (await candidate("before", 2)).json();
		expect(candidateBefore.accepted).toBe(true);
		expect((await removeSource("stale", 1)).status).toBe(400);
		const removed = await (await removeSource("remove", 2)).json();
		expect(removed).toEqual({
			id: created.id,
			revision: 3,
			digest: created.digest,
		});
		expect(await (await removeSource("remove", 2)).json()).toEqual(removed);
		expect((await removeSource("conflict", 2)).status).toBe(400);
		const afterRemoval = await (await candidate("after", 3)).json();
		expect(afterRemoval.accepted).toBe(false);
		expect(
			afterRemoval.entries.some(
				(entry: { status: string }) => entry.status === "missing-source",
			),
		).toBe(true);
		expect((await removeSource("absent-again", 3)).status).toBe(400);
		expect((await removeSource("replay-other", 4)).status).toBe(400);
		await stage("restage", 3, "first");
		const restored = await (await candidate("restored", 4)).json();
		expect(restored.accepted).toBe(true);
		const draft = await (
			await api(`/api/environments/drafts?id=${created.id}`)
		).json();
		expect(draft.revision).toBe(4);
		expect(draft.sources).toHaveLength(1);
		expect(
			await (
				await api(`${checkRoute}?id=${encodeURIComponent(restored.id)}`)
			).json(),
		).toEqual(restored);
		expect(
			(
				await api(draftRemoval, {
					requestId: "stale-delete",
					id: created.id,
					revision: 3,
				})
			).status,
		).toBe(400);
		expect(
			(
				await api(draftRemoval, {
					requestId: "unknown-delete-field",
					id: created.id,
					revision: 4,
					content: "x",
				})
			).status,
		).toBe(400);
		const deleted = await (
			await api(draftRemoval, {
				requestId: "delete",
				id: created.id,
				revision: 4,
			})
		).json();
		expect(deleted).toEqual({ id: created.id, removed: true });
		expect(
			await (
				await api(draftRemoval, {
					requestId: "delete",
					id: created.id,
					revision: 4,
				})
			).json(),
		).toEqual(deleted);
		expect(
			(await api(`/api/environments/drafts?id=${created.id}`)).status,
		).toBe(400);
		expect(await (await api("/api/environments/drafts")).json()).toEqual([]);
		expect(
			await (
				await api(`${checkRoute}?id=${encodeURIComponent(restored.id)}`)
			).json(),
		).toEqual(restored);
		expect(
			(
				await api(checkRoute, {
					requestId: "post-delete",
					id: created.id,
					revision: 4,
					digest: created.digest,
					validateStagedCandidate: true,
				})
			).status,
		).toBe(400);
		const replacement = await (
			await api("/api/environments/drafts", {
				requestId: "recreate",
				content: JSON.stringify({ version: 1, projects: [] }),
			})
		).json();
		expect(replacement.id).toMatch(/^draft-[a-f0-9]{64}$/);
		expect(replacement.revision).toBe(1);
		expect(fs.readFileSync(live, "utf8")).toBe(liveText);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		const snapshot = await app.snapshot();
		expect(snapshot.tasks).toHaveLength(0);
		expect(snapshot.reviews).toHaveLength(0);
		expect(JSON.stringify(snapshot)).not.toContain(created.id);
		host.stop();
		await app.close();
		host = serve(await open());
		expect(await (await api("/api/environments/drafts")).json()).toEqual([
			{ id: replacement.id, revision: 1, digest: replacement.digest },
		]);
		expect(
			await (
				await api(`${checkRoute}?id=${encodeURIComponent(restored.id)}`)
			).json(),
		).toEqual(restored);
		const historyRoute = "/api/environments/drafts/preflights";
		expect((await fetch(new URL(historyRoute, host.url))).status).toBe(401);
		expect((await api(`${historyRoute}?id=${restored.id}`)).status).toBe(400);
		const history = await (await api(historyRoute)).json();
		expect(history.map((entry: { id: string }) => entry.id)).toEqual([
			restored.id,
			afterRemoval.id,
			candidateBefore.id,
		]);
		expect(history[0]).toEqual({
			id: restored.id,
			draftId: created.id,
			revision: 4,
			digest: created.digest,
			observedAt: restored.observedAt,
			ordinal: restored.ordinal,
		});
		expect(fs.readFileSync(live, "utf8")).toBe(liveText);
	} finally {
		host.stop();
	}
});

test("saved binding removal repairs orphaned or invalid drafts without resolving their JSON targets", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app),
		token = new URLSearchParams(new URL(host.url).hash.slice(1)).get("token"),
		api = (route: string, body?: unknown) =>
			fetch(new URL(`/api/environments/drafts${route}`, host.url), {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
	try {
		const content = JSON.stringify({
				version: 1,
				projects: [
					{
						id: "orphan",
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
			created = await (
				await api("", { requestId: "orphan-create", content })
			).json();
		await api("/source", {
			requestId: "orphan-stage",
			id: created.id,
			revision: 1,
			app: "orphan",
			target: "stack",
			content: "services:\n  fixture:\n    image: fixture:latest\n",
		});
		const loaded = await (await api(`?id=${created.id}`)).json(),
			bindingDigest = loaded.sourceBindings[0].bindingDigest;
		expect(bindingDigest).toMatch(/^[a-f0-9]{64}$/);
		const edited = await (
				await api("", {
					requestId: "orphan-json",
					id: created.id,
					revision: 2,
					content: JSON.stringify({ version: 1, projects: [] }),
				})
			).json(),
			report = await (
				await api("/preflight", {
					requestId: "orphan-report",
					id: created.id,
					revision: 3,
					digest: edited.digest,
					validateStagedCandidate: true,
				})
			).json();
		expect(report.orphanBindings).toEqual([bindingDigest]);
		expect(
			(
				await api("/source/remove", {
					requestId: "orphan-target",
					id: created.id,
					revision: 3,
					app: "orphan",
					target: "stack",
				})
			).status,
		).toBe(400);
		const invalid = await (
				await api("", {
					requestId: "invalid-json",
					id: created.id,
					revision: 3,
					content: "{ invalid staged JSON",
				})
			).json(),
			removal = {
				requestId: "orphan-remove",
				id: created.id,
				revision: 4,
				bindingDigest,
			};
		expect(
			(await api("/source/remove", { ...removal, revision: 3 })).status,
		).toBe(400);
		expect(
			(
				await api("/source/remove", {
					...removal,
					app: "orphan",
					target: "stack",
				})
			).status,
		).toBe(400);
		const removed = await (await api("/source/remove", removal)).json();
		expect(removed).toEqual({
			id: created.id,
			revision: 5,
			digest: invalid.digest,
		});
		expect(await (await api("/source/remove", removal)).json()).toEqual(
			removed,
		);
		expect(
			(
				await api("/source/remove", {
					...removal,
					bindingDigest: "0".repeat(64),
				})
			).status,
		).toBe(400);
		const after = await (await api(`?id=${created.id}`)).json();
		expect(after.content).toBe("{ invalid staged JSON");
		expect(after.sources).toEqual([]);
		expect(after.sourceBindings).toEqual([]);
		expect(await (await api(`/preflight?id=${report.id}`)).json()).toEqual(
			report,
		);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(config.repositories[0] ?? "", "compose.yaml")),
		).toBe(false);
	} finally {
		host.stop();
	}
});
