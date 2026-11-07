import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("saved candidate coverage binds all source/base inputs, refuses gaps/orphans and replays immutable historical reports without publication", async () => {
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
		const repository = config.repositories[0] ?? "",
			live = path.join(repository, "compose.yaml"),
			liveText = "invalid-live-candidate-source-marker";
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
					targets: [
						target("first", "compose.yaml"),
						target("alias", "./compose.yaml"),
						target("second", "compose.other.yaml"),
					],
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
			checkRoute = "/api/environments/drafts/preflight",
			marker = "private-staged-candidate-marker",
			content = `services:\n  ${marker}:\n    image: fixture:latest\n    command: [echo, ${marker}]\n`;
		const stage = (
			requestId: string,
			revision: number,
			target: string,
			text = content,
		) =>
			api(sourceRoute, {
				requestId,
				id: created.id,
				revision,
				app: "api",
				target,
				content: text,
			});
		await stage("first", 1, "first");
		const body = {
			requestId: "initial",
			id: created.id,
			revision: 2,
			digest: created.digest,
			validateStagedCandidate: true,
		};
		expect(
			(
				await fetch(new URL(checkRoute, host.url), {
					method: "POST",
					body: JSON.stringify(body),
				})
			).status,
		).toBe(401);
		expect(
			(await api(checkRoute, { ...body, readComposeSource: true })).status,
		).toBe(400);
		const response = await api(checkRoute, body);
		expect(response.status).toBe(200);
		const missing = await response.json();
		expect(missing.accepted).toBe(false);
		expect(
			missing.entries.some(
				(entry: { status: string }) => entry.status === "missing-source",
			),
		).toBe(true);
		await stage("second", 2, "second");
		const check = (
			requestId: string,
			revision: number,
			digest = created.digest,
		) => api(checkRoute, { ...body, requestId, revision, digest });
		const accepted = await (await check("complete", 3)).json();
		expect(accepted.accepted).toBe(true);
		expect(accepted.entries).toHaveLength(3);
		expect(accepted.sourceCount).toBe(2);
		expect(accepted.manifest.sourceBindings).toHaveLength(2);
		expect(accepted.unobservedBaseCount).toBe(2);
		expect(accepted.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(accepted.isolatedTreeChecked).toBe(false);
		expect(accepted.publicationAllowed).toBe(false);
		expect(JSON.stringify(accepted)).not.toContain(marker);
		expect(JSON.stringify(accepted)).not.toContain(liveText);
		await stage("same-text", 3, "first");
		const unchanged = await (await check("same-inputs", 4)).json();
		expect(unchanged.candidateDigest).toBe(accepted.candidateDigest);
		const load = async () =>
			await (await api(`/api/environments/drafts?id=${created.id}`)).json();
		const source = (await load()).sources.find(
			(source: { file: string }) => source.file === "compose.yaml",
		);
		const base = await api(`${sourceRoute}/base`, {
			requestId: "base",
			id: created.id,
			revision: 4,
			app: "api",
			target: "first",
			sourceDigest: source.digest,
			readBase: true,
			acceptCurrentBase: true,
		});
		expect(base.status).toBe(200);
		const bound = await (await check("base-bound", 5)).json();
		expect(bound.accepted).toBe(true);
		expect(bound.candidateDigest).not.toBe(accepted.candidateDigest);
		expect(bound.observedBaseCount).toBe(1);
		expect(bound.baseFreshnessChecked).toBe(false);
		await stage("invalid", 5, "second", "unsupported-private-yaml-text");
		const invalid = await (await check("invalid", 6)).json();
		expect(invalid.accepted).toBe(false);
		expect(
			invalid.entries.some(
				(entry: { status: string }) => entry.status === "refused",
			),
		).toBe(true);
		expect(JSON.stringify(invalid)).not.toContain(
			"unsupported-private-yaml-text",
		);
		definition.projects[0]?.targets.splice(
			0,
			2,
			target("replacement", "compose.new.yaml"),
		);
		const changed = await (
			await api("/api/environments/drafts", {
				requestId: "retarget",
				id: created.id,
				revision: 6,
				content: JSON.stringify(definition),
			})
		).json();
		const orphan = await (await check("orphan", 7, changed.digest)).json();
		expect(orphan.accepted).toBe(false);
		expect(orphan.orphanBindings).toHaveLength(1);
		expect(
			orphan.entries.some(
				(entry: { status: string }) => entry.status === "missing-source",
			),
		).toBe(true);
		expect((await check("stale", 2)).status).toBe(400);
		expect(await (await api(checkRoute, body)).json()).toEqual(missing);
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
		expect(JSON.stringify(snapshot)).not.toContain(accepted.candidateDigest);
		host.stop();
		await app.close();
		host = serve(await open());
		expect(await (await api(checkRoute, body)).json()).toEqual(missing);
		expect(
			await (
				await api(`/api/environments/drafts/preflight?id=${orphan.id}`)
			).json(),
		).toEqual(orphan);
	} finally {
		host.stop();
	}
});
