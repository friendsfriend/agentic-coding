import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("private metadata preflight binds exact revision, reports real defaults/path failures and retains historical observations without executing or publishing", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		fs.mkdirSync(path.join(config.repositories[0] ?? "", "checked"));
	});
	let host = serve(app);
	const client = () => {
		const url = new URL(host.url),
			headers = {
				Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			};
		return {
			get: (route: string) => fetch(new URL(route, url), { headers }),
			post: (route: string, body: unknown) =>
				fetch(new URL(route, url), {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				}),
		};
	};
	try {
		let api = client();
		const marker = "private-preflight-command-fixture",
			repository = config.repositories[0];
		const target = {
			id: "build",
			action: "build",
			runtime: "shell",
			cwd: "checked",
			command: `touch preflight-executed; echo ${marker}`,
		};
		const content = JSON.stringify({
			version: 1,
			projects: [
				{ id: "api", kind: "app", repository, targets: [target] },
				{
					id: "ambiguous",
					kind: "library",
					repository,
					targets: [
						{ ...target, id: "one" },
						{ ...target, id: "two" },
					],
				},
			],
		});
		const saved = await (
			await api.post("/api/environments/drafts", {
				requestId: "draft",
				content,
			})
		).json();
		const body = {
				id: saved.id,
				revision: saved.revision,
				digest: saved.digest,
				requestId: "observe",
			},
			route = "/api/environments/drafts/preflight";
		expect(
			(await api.post(route, { ...body, digest: "0".repeat(64) })).status,
		).toBe(400);
		expect((await api.post(`${route}?publish=true`, body)).status).toBe(400);
		expect((await api.post(route, { ...body, promote: true })).status).toBe(
			400,
		);
		expect(
			(
				await fetch(
					new URL(`${route}?id=preflight-${"0".repeat(64)}`, host.url),
				)
			).status,
		).toBe(401);
		const response = await api.post(route, body);
		expect(response.status).toBe(200);
		const first = await response.json();
		expect(first).toMatchObject({
			draftId: saved.id,
			revision: 1,
			digest: saved.digest,
			historical: true,
			sourceContentsChecked: false,
			runtimeChecked: false,
			dependenciesExpanded: false,
		});
		expect(
			first.entries.find(
				(entry: { app: string; action: string }) =>
					entry.app === "api" && entry.action === "build",
			),
		).toMatchObject({
			target: "build",
			status: "observed",
			defaultReason: "only-candidate",
		});
		expect(
			first.entries.find(
				(entry: { app: string; action: string }) =>
					entry.app === "ambiguous" && entry.action === "build",
			).status,
		).toBe("unresolved");
		expect(JSON.stringify(first)).not.toContain(marker);
		expect(await (await api.post(route, body)).json()).toEqual(first);
		expect((await api.post(route, { ...body, revision: 2 })).status).toBe(400);
		fs.rmdirSync(path.join(repository ?? "", "checked"));
		fs.symlinkSync(config.stateDir, path.join(repository ?? "", "checked"));
		const changed = await (
			await api.post(route, { ...body, requestId: "observe-changed" })
		).json();
		expect(
			changed.entries.find(
				(entry: { app: string; action: string }) =>
					entry.app === "api" && entry.action === "build",
			).status,
		).toBe("unresolved");
		expect(JSON.stringify(changed.entries)).not.toContain(config.stateDir);
		expect(changed.ordinal).toBeGreaterThan(first.ordinal);
		expect(await (await api.get(`${route}?id=${first.id}`)).json()).toEqual(
			first,
		);
		const edited = await (
			await api.post("/api/environments/drafts", {
				id: saved.id,
				revision: 1,
				requestId: "edit",
				content: '{"version":1,"projects":[]}',
			})
		).json();
		expect(edited.revision).toBe(2);
		expect(
			(await api.post(route, { ...body, requestId: "stale" })).status,
		).toBe(400);
		expect(await (await api.post(route, body)).json()).toEqual(first);
		const snapshot = await app.snapshot();
		expect(snapshot.tasks).toHaveLength(0);
		expect(snapshot.reviews).toHaveLength(0);
		expect(snapshot.environments.runs).toHaveLength(0);
		expect(snapshot.environments.projects).toHaveLength(0);
		expect(JSON.stringify(snapshot)).not.toContain(first.id);
		expect(
			fs.existsSync(path.join(repository ?? "", "checked/preflight-executed")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		host.stop();
		await app.close();
		host = serve(await open());
		api = client();
		expect(await (await api.get(`${route}?id=${first.id}`)).json()).toEqual(
			first,
		);
		const draft = await (
			await api.get(`/api/environments/drafts?id=${saved.id}`)
		).json();
		expect(draft.preflightReports).toHaveLength(2);
		expect(draft.preflightReports.at(-1).id).toBe(changed.id);
		expect(
			draft.preflightReports.every(
				(report: { revision: number }) => report.revision === 1,
			),
		).toBe(true);
	} finally {
		host.stop();
	}
});
