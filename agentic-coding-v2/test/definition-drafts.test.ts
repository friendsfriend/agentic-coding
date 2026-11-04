import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("authenticated private native drafts fence revisions, replay receipts, revalidate schema and survive reopen without publication or execution", async () => {
	let live = "";
	const marker = "draft-only-private-fixture";
	const { app, config, open } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		live = JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0],
					targets: [
						{
							id: "build",
							action: "build",
							runtime: "shell",
							command: "echo live",
						},
					],
				},
			],
		});
		fs.writeFileSync(path.join(config.configDir, "environments.json"), live);
	});
	let host = serve(app);
	const client = () => {
		const url = new URL(host.url),
			headers = {
				Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			};
		return {
			get: (suffix = "") =>
				fetch(new URL(`/api/environments/drafts${suffix}`, url), { headers }),
			save: (body: unknown, origin?: string) =>
				fetch(new URL("/api/environments/drafts", url), {
					method: "POST",
					headers: { ...headers, ...(origin ? { Origin: origin } : {}) },
					body: JSON.stringify(body),
				}),
			url,
		};
	};
	try {
		let api = client();
		const content = live.replace(
				"echo live",
				`touch draft-executed; echo ${marker}`,
			),
			create = { requestId: "create-draft", content };
		expect(
			(await fetch(new URL("/api/environments/drafts", api.url))).status,
		).toBe(401);
		expect((await api.save(create, "https://foreign.invalid")).status).toBe(
			403,
		);
		const destination = path.join(config.configDir, "environments.json");
		fs.renameSync(destination, path.join(config.configDir, "reference.json"));
		fs.symlinkSync(path.join(config.configDir, "reference.json"), destination);
		expect(
			(await api.save({ ...create, requestId: "linked-base" })).status,
		).toBe(400);
		fs.unlinkSync(destination);
		fs.renameSync(path.join(config.configDir, "reference.json"), destination);
		const result = await api.save(create);
		expect(result.status).toBe(200);
		const saved = await result.json();
		expect(saved.revision).toBe(1);
		expect(await (await api.save(create)).json()).toEqual(saved);
		expect((await api.save({ ...create, content: "{}" })).status).toBe(400);
		expect(await (await api.get()).json()).toHaveLength(1);
		const read = () => api.get(`?id=${saved.id}`);
		const first = await (await read()).json();
		expect(first.content).toBe(content);
		expect(first.schema).toMatchObject({
			scope: "schema-only",
			valid: true,
			contentDigest: saved.digest,
		});
		expect(first.baseMatches).toBe(true);
		expect(first.base.digest).toMatch(/^[a-f0-9]{64}$/);
		const invalid = await api.save({
			id: saved.id,
			revision: 1,
			requestId: "invalid-edit",
			content: `{ ${marker}`,
		});
		expect(invalid.status).toBe(200);
		const malformed = await (await read()).json();
		expect(malformed.schema.valid).toBe(false);
		expect(malformed.schema.message).not.toContain(marker);
		const statuses = await Promise.all(
			["race-a", "race-b"].map(
				async (requestId) =>
					(await api.save({ id: saved.id, revision: 2, requestId, content }))
						.status,
			),
		);
		expect(statuses.sort()).toEqual([200, 400]);
		const current = await (await read()).json();
		expect(current.revision).toBe(3);
		expect(current.schema.valid).toBe(true);
		expect(
			(
				await api.save({
					id: saved.id,
					revision: 1,
					requestId: "stale",
					content,
				})
			).status,
		).toBe(400);
		expect(
			(await api.save({ ...create, requestId: "not-promote", promote: true }))
				.status,
		).toBe(400);
		expect(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		).toBe(live);
		expect(
			fs.existsSync(path.join(config.repositories[0] ?? "", "draft-executed")),
		).toBe(false);
		const state = await app.snapshot();
		expect(JSON.stringify(state)).not.toContain(marker);
		expect(state.tasks).toHaveLength(0);
		expect(state.reviews).toHaveLength(0);
		expect(state.environments.runs).toHaveLength(0);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({ version: 1, projects: [] }),
		);
		expect((await (await read()).json()).baseMatches).toBe(false);
		host.stop();
		await app.close();
		const reopened = await open();
		host = serve(reopened);
		api = client();
		const restored = await (await read()).json();
		expect(restored.content).toBe(content);
		expect(restored.revision).toBe(3);
		expect(restored.baseMatches).toBe(false);
		expect(await (await api.save(create)).json()).toEqual(saved);
		expect((await reopened.snapshot()).environments.projects).toHaveLength(0);
	} finally {
		host.stop();
	}
});

test("draft admission refuses state inside an authorized checkout", async () => {
	const { app } = await fixture(false, (config) => {
		config.stateDir = config.repositories[0] ?? "";
		fs.chmodSync(config.stateDir, 0o700);
	});
	const host = serve(app);
	try {
		const url = new URL(host.url);
		const response = await fetch(new URL("/api/environments/drafts", url), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				requestId: "unsafe-state",
				content: '{"version":1,"projects":[]}',
			}),
		});
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain(
			"outside every authorized repository",
		);
	} finally {
		host.stop();
	}
});
