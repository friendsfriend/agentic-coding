import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("private staged Compose edits advance draft revision, parse saved bytes not live sources, retain exact retries and survive reopen without publication", async () => {
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
			post: (body: unknown, route = "/api/environments/drafts") =>
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
			live = path.join(repo, "compose.yaml"),
			liveText = "unsupported-live-source-literal";
		fs.writeFileSync(live, liveText);
		const content = (file = "compose.yaml") =>
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
		const created = await (
			await api.post({ requestId: "create", content: content() })
		).json();
		const marker = "private-staged-source-marker",
			yaml = `services:\n  ${marker}:\n    image: fixture:latest\n    command: [echo, ${marker}]\n`;
		const sourceBody = {
				requestId: "stage",
				id: created.id,
				revision: 1,
				app: "api",
				target: "stack",
				content: yaml,
			},
			sourceRoute = "/api/environments/drafts/source",
			checkRoute = "/api/environments/drafts/preflight";
		expect(
			(
				await fetch(new URL(sourceRoute, host.url), {
					method: "POST",
					body: JSON.stringify(sourceBody),
				})
			).status,
		).toBe(401);
		expect(
			(await api.post({ ...sourceBody, publish: true }, sourceRoute)).status,
		).toBe(400);
		const response = await api.post(sourceBody, sourceRoute);
		expect(response.status).toBe(200);
		const saved = await response.json();
		expect(saved.revision).toBe(2);
		expect(saved.digest).toBe(created.digest);
		expect(await (await api.post(sourceBody, sourceRoute)).json()).toEqual(
			saved,
		);
		expect(
			(await api.post({ ...sourceBody, requestId: "stale" }, sourceRoute))
				.status,
		).toBe(400);
		expect(
			(await api.post({ ...sourceBody, content: `${yaml}\n` }, sourceRoute))
				.status,
		).toBe(400);
		const checkBody = {
			requestId: "staged-check",
			id: saved.id,
			revision: 2,
			digest: saved.digest,
			app: "api",
			target: "stack",
			useStagedSource: true,
		};
		const accepted = await (await api.post(checkBody, checkRoute)).json();
		expect(accepted).toMatchObject({
			kind: "staged-compose-source",
			accepted: true,
			origin: "private-staged-text",
			serviceCount: 1,
			historical: true,
			runtimeChecked: false,
			sourceContentsChecked: false,
		});
		expect(accepted.stagedDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(accepted)).not.toContain(marker);
		const repositoryCheck = await (
			await api.post(
				{
					...checkBody,
					requestId: "live-check",
					useStagedSource: undefined,
					readComposeSource: true,
				},
				checkRoute,
			)
		).json();
		expect(repositoryCheck.accepted).toBe(false);
		expect(
			(
				await api.post(
					{ ...checkBody, requestId: "mixed", readComposeSource: true },
					checkRoute,
				)
			).status,
		).toBe(400);
		const invalid = await (
			await api.post(
				{
					...sourceBody,
					requestId: "invalid-edit",
					revision: 2,
					content: "not compose yaml",
				},
				sourceRoute,
			)
		).json();
		expect(invalid.revision).toBe(3);
		expect(
			(
				await (
					await api.post(
						{ ...checkBody, requestId: "invalid-check", revision: 3 },
						checkRoute,
					)
				).json()
			).accepted,
		).toBe(false);
		expect(await (await api.post(checkBody, checkRoute)).json()).toEqual(
			accepted,
		);
		const edited = await (
			await api.post({
				requestId: "retarget",
				id: saved.id,
				revision: 3,
				content: content("compose.dev.yaml"),
			})
		).json();
		expect(edited.revision).toBe(4);
		expect(
			(
				await api.post(
					{
						...checkBody,
						requestId: "missing-binding",
						revision: 4,
						digest: edited.digest,
					},
					checkRoute,
				)
			).status,
		).toBe(400);
		const loaded = await (
			await api.get(`/api/environments/drafts?id=${saved.id}`)
		).json();
		expect(loaded.sources[0]).toMatchObject({
			file: "compose.yaml",
			content: "not compose yaml",
			base: "unobserved",
		});
		expect(fs.readFileSync(live, "utf8")).toBe(liveText);
		expect(fs.existsSync(path.join(repo, "compose.dev.yaml"))).toBe(false);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		const state = await app.snapshot();
		expect(state.tasks).toHaveLength(0);
		expect(state.reviews).toHaveLength(0);
		expect(state.environments.projects).toHaveLength(0);
		expect(JSON.stringify(state)).not.toContain("not compose yaml");
		host.stop();
		await app.close();
		host = serve(await open());
		api = client();
		expect(
			(await (await api.get(`/api/environments/drafts?id=${saved.id}`)).json())
				.sources,
		).toEqual(loaded.sources);
		expect(await (await api.post(sourceBody, sourceRoute)).json()).toEqual(
			saved,
		);
		expect(await (await api.post(checkBody, checkRoute)).json()).toEqual(
			accepted,
		);
		// A declared env_file is honoured only from a staged auxiliary source: the
		// staged bytes are the input, so no live file is read and no value leaks.
		const envDraft = await (
				await api.post({ requestId: "env-create", content: content() })
			).json(),
			envSource =
				"services:\n  api:\n    image: fixture:latest\n    env_file: conf/app.env\n    environment:\n      MODE: inline\n",
			stageEnv = (body: Record<string, unknown>) =>
				api.post(
					{ id: envDraft.id, app: "api", target: "stack", ...body },
					sourceRoute,
				),
			firstStaged = await (
				await stageEnv({
					requestId: "env-compose",
					revision: 1,
					content: envSource,
				})
			).json(),
			checkEnv = async (revision: number, digestValue: string) =>
				await (
					await api.post(
						{
							requestId: `env-check-${revision}`,
							id: envDraft.id,
							revision,
							digest: digestValue,
							app: "api",
							target: "stack",
							useStagedSource: true,
						},
						checkRoute,
					)
				).json(),
			withoutAuxiliary = await checkEnv(
				firstStaged.revision,
				firstStaged.digest,
			);
		expect(withoutAuxiliary.accepted).toBe(false);
		expect(JSON.stringify(withoutAuxiliary)).not.toContain("app.env");
		const withAuxiliary = await (
			await stageEnv({
				requestId: "env-auxiliary",
				revision: firstStaged.revision,
				file: "conf/app.env",
				auxiliary: true,
				content: "MODE=from-file\nTOKEN=staged-only\n",
			})
		).json();
		const acceptedEnv = await checkEnv(
			withAuxiliary.revision,
			withAuxiliary.digest,
		);
		expect(acceptedEnv.accepted).toBe(true);
		expect(JSON.stringify(acceptedEnv)).not.toContain("staged-only");
		expect(JSON.stringify(acceptedEnv)).not.toContain("app.env");
	} finally {
		host.stop();
	}
});
