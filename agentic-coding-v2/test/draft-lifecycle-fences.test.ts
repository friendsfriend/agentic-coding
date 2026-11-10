import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Draft storage is bounded and single-writer: oversized or unknown fields are
// refused, well-formed unknown IDs stay unknown, stale revisions never
// preflight, request IDs are idempotent for identical input only, and staged
// sources are capped per draft. Proofs run against the HTTP boundary.
const setup = async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	const headers = {
		Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
		"Content-Type": "application/json",
	};
	const post = (route: string, body: unknown) =>
		fetch(new URL(route, host.url), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	const plan = () =>
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0] ?? "",
					targets: [
						{
							id: "stack",
							action: "run",
							runtime: "compose",
							compose: {
								file: "compose.yaml",
								provider: "docker",
								socket: path.join(config.stateDir, "absent-engine.sock"),
							},
						},
					],
				},
			],
		});
	const create = (
		requestId: string,
		content: string,
		extra?: Record<string, unknown>,
	) => post("/api/environments/drafts", { requestId, content, ...extra });
	return { app, host, headers, post, create, plan };
};
const unknownId = `draft-${"0".repeat(64)}`;
const yaml = (service: string) =>
	`services:\n  ${service}:\n    image: fixture:latest\n`;
test("creation refuses unknown fields and oversized content", async () => {
	const { app, host, create, plan } = await setup();
	try {
		const unknown = await create("create", plan(), { publish: true });
		expect(unknown.status).toBe(400);
		expect(await unknown.text()).toContain("Unsupported draft field");
		const oversized = await create(
			"oversized",
			`{"version":1,"pad":"${"x".repeat(262145)}"}`,
		);
		expect(oversized.status).toBe(400);
	} finally {
		host.stop();
		await app.close();
	}
});
test("well-formed unknown draft IDs stay unknown", async () => {
	const { app, host, headers } = await setup();
	try {
		const loaded = await fetch(
			new URL(`/api/environments/drafts?id=${unknownId}`, host.url),
			{ headers },
		);
		expect(loaded.status).toBe(400);
		expect(await loaded.text()).toContain("Unknown definition draft");
	} finally {
		host.stop();
		await app.close();
	}
});
test("stale revisions never preflight and request IDs are idempotent for identical input only", async () => {
	const { app, host, headers, post, create, plan } = await setup();
	try {
		const created = await (await create("create", plan())).json();
		const source = {
			requestId: "stage",
			id: created.id,
			revision: 1,
			app: "api",
			target: "stack",
			content: yaml("web"),
		};
		const staged = await (
			await post("/api/environments/drafts/source", source)
		).json();
		expect(staged.revision).toBe(2);
		const retry = await post("/api/environments/drafts/source", source);
		expect(await retry.json()).toEqual(staged);
		const reused = await post("/api/environments/drafts/source", {
			...source,
			content: `${source.content}\n`,
		});
		expect(reused.status).toBe(400);
		expect(await reused.text()).toContain("reused");
		const stale = await post("/api/environments/drafts/preflight", {
			requestId: "stale-check",
			id: created.id,
			revision: 1,
			digest: created.digest,
			app: "api",
			target: "stack",
			useStagedSource: true,
		});
		expect(stale.status).toBe(400);
		expect(await stale.text()).toContain("Draft changed");
		const loaded = await (
			await fetch(
				new URL(`/api/environments/drafts?id=${created.id}`, host.url),
				{ headers },
			)
		).json();
		expect(loaded.revision).toBe(2);
	} finally {
		host.stop();
		await app.close();
	}
});
test("staged sources are capped per draft by count and by bytes", async () => {
	const { app, host, post, create, plan } = await setup();
	try {
		const created = await (await create("create", plan())).json();
		let revision = 1;
		const stage = (requestId: string, body: Record<string, unknown>) =>
			post("/api/environments/drafts/source", {
				requestId,
				id: created.id,
				revision,
				app: "api",
				target: "stack",
				...body,
			});
		revision = (
			await (await stage("stage-declared", { content: yaml("web") })).json()
		).revision;
		for (const name of ["aux-a", "aux-b", "aux-c"]) {
			revision = (
				await (
					await stage(`stage-${name}`, {
						content: yaml(name),
						auxiliary: true,
						file: `${name}.yaml`,
					})
				).json()
			).revision;
		}
		expect(revision).toBe(5);
		const fifth = await stage("stage-aux-d", {
			content: yaml("aux-d"),
			auxiliary: true,
			file: "aux-d.yaml",
		});
		expect(fifth.status).toBe(400);
		expect(await fifth.text()).toContain("capacity");
		const createdB = await (await create("create-b", plan())).json();
		let revisionB = 1;
		const stageB = (requestId: string, body: Record<string, unknown>) =>
			post("/api/environments/drafts/source", {
				requestId,
				id: createdB.id,
				revision: revisionB,
				app: "api",
				target: "stack",
				...body,
			});
		revisionB = (
			await (await stageB("stage-b-declared", { content: yaml("web") })).json()
		).revision;
		for (const name of ["big-a", "big-b"]) {
			revisionB = (
				await (
					await stageB(`stage-b-${name}`, {
						content: `${yaml(name)}# ${"x".repeat(50000)}\n`,
						auxiliary: true,
						file: `${name}.yaml`,
					})
				).json()
			).revision;
		}
		const huge = await stageB("stage-b-huge", {
			content: `${yaml("big-c")}# ${"x".repeat(40000)}\n`,
			auxiliary: true,
			file: "big-c.yaml",
		});
		expect(huge.status).toBe(400);
		expect(await huge.text()).toContain("capacity");
		const unknownField = await post("/api/environments/drafts/source", {
			requestId: "stage-unknown",
			id: createdB.id,
			revision: 1,
			app: "api",
			target: "stack",
			content: yaml("web"),
			publish: true,
		});
		expect(unknownField.status).toBe(400);
	} finally {
		host.stop();
		await app.close();
	}
});
