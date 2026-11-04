import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("explicit private source check validates one captured Compose file, withholds source values, refuses links/private names and never executes or publishes", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
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
			post: (body: unknown, route = "/api/environments/drafts/preflight") =>
				fetch(new URL(route, url), {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				}),
		};
	};
	try {
		let api = client();
		const repo = config.repositories[0] ?? "",
			file = path.join(repo, "compose.yaml"),
			marker = "private-source-literal-fixture";
		fs.writeFileSync(
			file,
			`services:\n  ${marker}:\n    image: fixture:latest\n    command: [echo, ${marker}]\n    environment:\n      PRIVATE_FIXTURE: ${marker}\n`,
		);
		const content = (file: string) =>
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: repo,
						targets: [
							{
								id: "stack",
								action: "run",
								runtime: "compose",
								compose: {
									file,
									provider: "docker",
									socket: path.join(config.stateDir, "absent-engine.sock"),
								},
							},
						],
					},
				],
			});
		const saved = await (
			await api.post(
				{ requestId: "create", content: content("compose.yaml") },
				"/api/environments/drafts",
			)
		).json();
		const body = {
			requestId: "read-source",
			id: saved.id,
			revision: saved.revision,
			digest: saved.digest,
			app: "api",
			target: "stack",
			readComposeSource: true,
		};
		expect((await api.post({ ...body, readComposeSource: false })).status).toBe(
			400,
		);
		expect(
			(await api.post({ ...body, readComposeSource: undefined })).status,
		).toBe(400);
		const response = await api.post(body);
		expect(response.status).toBe(200);
		const accepted = await response.json();
		expect(accepted).toMatchObject({
			kind: "compose-source",
			accepted: true,
			app: "api",
			target: "stack",
			historical: true,
			sourceContentsChecked: false,
			runtimeChecked: false,
			dependenciesExpanded: false,
			serviceCount: 1,
		});
		expect(accepted.checkedSource.contentDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(accepted.compiledDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(accepted)).not.toContain(marker);
		fs.writeFileSync(
			file,
			`services:\n  web:\n    image: fixture:latest\n    unsupported: ${marker}\n`,
		);
		expect(await (await api.post(body)).json()).toEqual(accepted);
		const invalid = await (
			await api.post({ ...body, requestId: "invalid-source" })
		).json();
		expect(invalid.accepted).toBe(false);
		expect(JSON.stringify(invalid)).not.toContain(marker);
		fs.unlinkSync(file);
		fs.symlinkSync(path.join(config.configDir, "private.yaml"), file);
		fs.writeFileSync(
			path.join(config.configDir, "private.yaml"),
			`services:\n  hidden:\n    image: ${marker}\n`,
		);
		const linked = await (
			await api.post({ ...body, requestId: "linked-source" })
		).json();
		expect(linked).toMatchObject({ accepted: false, checkedSource: null });
		const edited = await (
			await api.post(
				{
					requestId: "private-name",
					id: saved.id,
					revision: 1,
					content: content(".env"),
				},
				"/api/environments/drafts",
			)
		).json();
		fs.writeFileSync(path.join(repo, ".env"), marker);
		const refused = await (
			await api.post({
				...body,
				requestId: "private-read",
				revision: edited.revision,
				digest: edited.digest,
			})
		).json();
		expect(refused).toMatchObject({ accepted: false, checkedSource: null });
		expect(
			(await api.post({ ...body, requestId: "stale-source" })).status,
		).toBe(400);
		const state = await app.snapshot();
		expect(state.tasks).toHaveLength(0);
		expect(state.reviews).toHaveLength(0);
		expect(state.environments.projects).toHaveLength(0);
		expect(state.environments.runs).toHaveLength(0);
		expect(JSON.stringify(state)).not.toContain(accepted.id);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		host.stop();
		await app.close();
		host = serve(await open());
		api = client();
		expect(
			await (
				await api.get(`/api/environments/drafts/preflight?id=${accepted.id}`)
			).json(),
		).toEqual(accepted);
		expect(await (await api.post(body)).json()).toEqual(accepted);
	} finally {
		host.stop();
	}
});
