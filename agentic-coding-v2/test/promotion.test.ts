import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("exact approved staged content is promoted atomically under a destination fence, idempotently and with immutable records", async () => {
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
	const live = path.join(config.configDir, "environments.json"),
		repository = config.repositories[0] ?? "",
		repositoryFile = path.join(repository, "compose.yaml"),
		repositoryText = "repository-marker-must-stay";
	try {
		fs.writeFileSync(repositoryFile, repositoryText);
		const document = (targetId: string) =>
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "promoted",
						kind: "app",
						repository,
						targets: [
							{
								id: targetId,
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
			});
		const create = (requestId: string, content: string) =>
				api("/api/environments/drafts", { requestId, content }),
			promoteRoute = "/api/environments/drafts/promote",
			promote = (
				requestId: string,
				id: string,
				revision: number,
				digest: string,
				approve: string,
			) => api(promoteRoute, { requestId, id, revision, digest, approve });
		expect(
			(
				await fetch(new URL(promoteRoute, host.url), {
					method: "POST",
					body: JSON.stringify({ id: "draft-x", revision: 1 }),
				})
			).status,
		).toBe(401);
		const created = await (
			await create("promote-create", document("v1"))
		).json();
		expect(fs.existsSync(live)).toBe(false);
		expect(
			(
				await api(promoteRoute, {
					requestId: "unknown",
					id: created.id,
					revision: 1,
					digest: created.digest,
					approve: created.digest,
					content: "x",
				})
			).status,
		).toBe(400);
		expect(
			(await promote("stale", created.id, 2, created.digest, created.digest))
				.status,
		).toBe(400);
		expect(
			(await promote("wrong-digest", created.id, 1, created.digest, "0"))
				.status,
		).toBe(400);
		expect(fs.existsSync(live)).toBe(false);
		fs.mkdirSync(config.configDir, { recursive: true });
		fs.writeFileSync(live, '{"version":1,"projects":[]}');
		const raced = await promote(
			"raced",
			created.id,
			1,
			created.digest,
			created.digest,
		);
		expect(raced.status).toBe(400);
		expect(fs.readFileSync(live, "utf8")).toBe('{"version":1,"projects":[]}');
		fs.rmSync(live);
		const promoted = await (
			await promote("first", created.id, 1, created.digest, created.digest)
		).json();
		expect(promoted).toMatchObject({
			outcome: "written",
			previous: null,
			projects: 1,
			targets: 1,
			bytes: Buffer.byteLength(document("v1")),
			sourceFilesWritten: false,
			repositoriesChanged: false,
			reloaded: false,
			runtimeChecked: false,
			destination: "environments.json",
		});
		expect(fs.readFileSync(live, "utf8")).toBe(document("v1"));
		expect(fs.statSync(live).mode & 0o777).toBe(0o600);
		expect(
			fs
				.readdirSync(config.configDir)
				.filter((entry) => entry.endsWith(".tmp")),
		).toEqual([]);
		expect(
			await (
				await promote("first", created.id, 1, created.digest, created.digest)
			).json(),
		).toEqual(promoted);
		const record = await (
			await api(`/api/environments/drafts/promotion?id=${promoted.id}`)
		).json();
		expect(record).toEqual(promoted);
		expect(
			(await api("/api/environments/drafts/promotion?id=promotion-absent"))
				.status,
		).toBe(400);
		const unchanged = await (
			await promote("again", created.id, 1, created.digest, created.digest)
		).json();
		expect(unchanged.outcome).toBe("unchanged");
		expect(fs.readFileSync(live, "utf8")).toBe(document("v1"));
		const second = await (
			await create("promote-second", document("v2"))
		).json();
		config.repositories.push(fs.realpathSync(config.configDir));
		expect(
			(await promote("inside-repo", second.id, 1, second.digest, second.digest))
				.status,
		).toBe(400);
		config.repositories.pop();
		expect(fs.readFileSync(live, "utf8")).toBe(document("v1"));
		fs.writeFileSync(live, '{"version":1,"projects":[]}');
		expect(
			(await promote("stale-base", second.id, 1, second.digest, second.digest))
				.status,
		).toBe(400);
		expect(fs.readFileSync(live, "utf8")).toBe('{"version":1,"projects":[]}');
		fs.writeFileSync(live, document("v1"));
		const replaced = await (
			await promote("second", second.id, 1, second.digest, second.digest)
		).json();
		expect(replaced.outcome).toBe("written");
		expect(replaced.previous).toBe(created.digest);
		expect(
			JSON.parse(fs.readFileSync(live, "utf8")).projects[0].targets[0].id,
		).toBe("v2");
		const invalid = await (
			await create(
				"promote-invalid",
				JSON.stringify({ version: 1, projects: [{ id: "x" }] }),
			)
		).json();
		expect(
			(await promote("invalid", invalid.id, 1, invalid.digest, invalid.digest))
				.status,
		).toBe(400);
		expect(fs.readFileSync(repositoryFile, "utf8")).toBe(repositoryText);
		const snapshot = await app.snapshot();
		expect(snapshot.tasks).toHaveLength(0);
		expect(snapshot.reviews).toHaveLength(0);
		host.stop();
		await app.close();
		host = serve(await open());
		expect(
			await (
				await api(`/api/environments/drafts/promotion?id=${promoted.id}`)
			).json(),
		).toEqual(promoted);
		expect(
			(await promote("first", created.id, 1, created.digest, created.digest))
				.status,
		).toBe(200);
		expect(fs.readFileSync(live, "utf8")).toContain('"v2"');
	} finally {
		host.stop();
	}
});
