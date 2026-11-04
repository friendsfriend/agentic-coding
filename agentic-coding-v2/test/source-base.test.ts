import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const sourceRoute = "/api/environments/drafts/source",
	baseRoute = `${sourceRoute}/base`,
	checkRoute = "/api/environments/drafts/preflight";
async function setup(file: string) {
	const context = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	let host = serve(context.app);
	const api = (route: string, body?: unknown) =>
		fetch(new URL(route, host.url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const repository = context.config.repositories[0] ?? "",
		content = JSON.stringify({
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
								file,
								provider: "docker",
								socket: path.join(context.config.stateDir, "absent.sock"),
							},
						},
					],
				},
			],
		}),
		created = await (
			await api("/api/environments/drafts", { requestId: "create", content })
		).json();
	const staged = await (
		await api(sourceRoute, {
			requestId: "stage",
			id: created.id,
			revision: 1,
			app: "api",
			target: "stack",
			content: "services:\n  staged:\n    image: fixture:latest\n",
		})
	).json();
	const load = async () =>
		await (await api(`/api/environments/drafts?id=${created.id}`)).json();
	const source = (await load()).sources[0];
	const capture = {
		requestId: "base",
		id: created.id,
		revision: 2,
		app: "api",
		target: "stack",
		sourceDigest: source.digest,
		readBase: true,
		acceptCurrentBase: true,
	};
	const check = {
		requestId: "compare",
		id: created.id,
		revision: 3,
		digest: created.digest,
		app: "api",
		target: "stack",
		compareSourceBase: true,
	};
	return {
		...context,
		api,
		repository,
		created,
		staged,
		load,
		capture,
		check,
		url: host.url,
		stop: () => host.stop(),
		reopen: async () => {
			host.stop();
			await context.app.close();
			host = serve(await context.open());
		},
	};
}
test("explicit current source bases survive edits/reopen, detect identity/content changes and never turn historical comparisons into authority", async () => {
	const s = await setup("compose.yaml");
	try {
		const file = path.join(s.repository, "compose.yaml"),
			live = "private-live-base-marker\n";
		fs.writeFileSync(file, live);
		expect(
			(
				await fetch(new URL(baseRoute, s.url), {
					method: "POST",
					body: JSON.stringify(s.capture),
				})
			).status,
		).toBe(401);
		expect(
			(await s.api(baseRoute, { ...s.capture, acceptCurrentBase: false }))
				.status,
		).toBe(400);
		expect(
			(await s.api(baseRoute, { ...s.capture, publish: true })).status,
		).toBe(400);
		const response = await s.api(baseRoute, s.capture);
		expect(response.status).toBe(200);
		const receipt = await response.json();
		expect(receipt.revision).toBe(3);
		expect(receipt.digest).toBe(s.created.digest);
		const base = (await s.load()).sources[0].base;
		expect(base).toMatchObject({
			state: "regular",
			basis: "explicit-current-base-not-staging-time",
		});
		expect(base.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		const matched = await (await s.api(checkRoute, s.check)).json();
		expect(matched.matches).toBe(true);
		expect(matched.historical).toBe(true);
		expect(matched.runtimeChecked).toBe(false);
		expect(JSON.stringify(matched)).not.toContain(live.trim());
		const edited = await (
			await s.api(sourceRoute, {
				requestId: "edit",
				id: s.created.id,
				revision: 3,
				app: "api",
				target: "stack",
				content: "invalid staged but retained",
			})
		).json();
		expect(edited.revision).toBe(4);
		expect((await s.load()).sources[0].base).toEqual(base);
		// Retain original inode while replacing its path with identical bytes.
		fs.renameSync(file, path.join(s.repository, "original-retained"));
		fs.writeFileSync(file, live);
		const replaced = await (
			await s.api(checkRoute, {
				...s.check,
				revision: 4,
				requestId: "replacement",
			})
		).json();
		expect(replaced.matches).toBe(false);
		expect(replaced.observed.contentDigest).toBe(base.contentDigest);
		fs.writeFileSync(file, "different live bytes");
		const changed = await (
			await s.api(checkRoute, { ...s.check, revision: 4, requestId: "changed" })
		).json();
		expect(changed.matches).toBe(false);
		expect(changed.observed.contentDigest).not.toBe(base.contentDigest);
		expect(
			(
				await s.api(baseRoute, {
					...s.capture,
					requestId: "overwrite",
					revision: 4,
					sourceDigest: (await s.load()).sources[0].digest,
				})
			).status,
		).toBe(400);
		expect(
			(
				await s.api(checkRoute, {
					...s.check,
					revision: 4,
					requestId: "mixed",
					useStagedSource: true,
				})
			).status,
		).toBe(400);
		await s.reopen();
		expect(await (await s.api(baseRoute, s.capture)).json()).toEqual(receipt);
		expect(await (await s.api(checkRoute, s.check)).json()).toEqual(matched);
		expect((await s.load()).sources[0].base).toEqual(base);
		expect(fs.readFileSync(file, "utf8")).toBe("different live bytes");
		expect(
			fs.existsSync(path.join(s.config.configDir, "environments.json")),
		).toBe(false);
		const snapshot = await (await s.api("/api/state")).json();
		expect(snapshot.tasks).toHaveLength(0);
		expect(snapshot.reviews).toHaveLength(0);
		expect(JSON.stringify(snapshot)).not.toContain(base.fingerprint);
	} finally {
		s.stop();
	}
});
test("absent parent/file bases are conservative and unsafe links are refused without changing private drafts", async () => {
	const s = await setup("nested/compose.yaml");
	try {
		const receipt = await (await s.api(baseRoute, s.capture)).json();
		expect(receipt.revision).toBe(3);
		expect((await s.load()).sources[0].base.state).toBe("absent");
		expect((await (await s.api(checkRoute, s.check)).json()).matches).toBe(
			true,
		);
		fs.mkdirSync(path.join(s.repository, "nested"));
		expect(
			(
				await (
					await s.api(checkRoute, { ...s.check, requestId: "parent-created" })
				).json()
			).matches,
		).toBe(false);
		fs.rmdirSync(path.join(s.repository, "nested"));
		fs.symlinkSync(s.config.configDir, path.join(s.repository, "nested"));
		expect(
			(
				await (
					await s.api(checkRoute, { ...s.check, requestId: "parent-link" })
				).json()
			).matches,
		).toBeNull();
		const updated = JSON.parse((await s.load()).content);
		updated.projects[0].targets[0].compose.file = "compose.link.yaml";
		await s.api("/api/environments/drafts", {
			requestId: "retarget",
			id: s.created.id,
			revision: 3,
			content: JSON.stringify(updated),
		});
		await s.api(sourceRoute, {
			requestId: "new-source",
			id: s.created.id,
			revision: 4,
			app: "api",
			target: "stack",
			content: "staged-text",
		});
		const privateFile = path.join(s.config.configDir, "private-input"),
			link = path.join(s.repository, "compose.link.yaml");
		fs.writeFileSync(privateFile, "never-import-private-marker");
		fs.symlinkSync(privateFile, link);
		const capture = {
			...s.capture,
			requestId: "unsafe",
			revision: 5,
			sourceDigest: (await s.load()).sources[1].digest,
		};
		expect((await s.api(baseRoute, capture)).status).toBe(400);
		fs.unlinkSync(link);
		fs.linkSync(privateFile, link);
		expect((await s.api(baseRoute, capture)).status).toBe(400);
		const draft = await s.load();
		expect(draft.revision).toBe(5);
		expect(draft.sources[1].base).toBe("unobserved");
		expect(draft.sources[1].content).toBe("staged-text");
		expect(fs.readFileSync(privateFile, "utf8")).toBe(
			"never-import-private-marker",
		);
	} finally {
		s.stop();
	}
});
