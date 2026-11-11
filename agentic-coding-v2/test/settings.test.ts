import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { digest, loadConfig } from "../src/config.ts";
import type { SettingsDefinition } from "../src/protocol/index.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("authenticated settings preserve later catalog rows, Unicode fields and opaque disk fields without changing running authority", async () => {
	const { app, config } = await fixture(false, (config) =>
		fs.mkdirSync(config.configDir, { mode: 0o700 }),
	);
	const host = serve(app),
		client = new ClientConnection(host.client),
		file = path.join(config.configDir, "config.json"),
		running = structuredClone({
			profiles: config.profiles,
			repositories: config.repositories,
			providers: config.providers,
		});
	fs.writeFileSync(
		file,
		JSON.stringify({
			privateExtra: { fixture: "not-projected-private-field" },
		}),
	);
	const repositories = Array.from({ length: 27 }, (_, index) => {
		const dir = path.join(config.configDir, `repository-${index}`);
		fs.mkdirSync(dir);
		return fs.realpathSync(dir);
	});
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const original = await client.call("settings.read", {}),
			before = fs.readFileSync(file);
		const proposed: SettingsDefinition = {
			profiles: Object.fromEntries(
				Array.from({ length: 27 }, (_, index) => [
					`draft-${index}`,
					{
						model: `${config.profiles[0]?.provider}/model-${index}`,
						thinking: "off",
						description: `Profile ${index} ${"supplied 😀 e\u0301\r\n".repeat(65)}`,
					},
				]),
			),
			orchestratorProfile: "draft-26",
			repositories,
			providers: Array.from({ length: 27 }, (_, index) => ({
				name: `provider-${index}`,
				type: "gitlab",
				baseUrl: `https://provider-${index}.example.invalid`,
				tokenRef: `FIXTURE_PROVIDER_${index}`,
			})),
		};
		const sealed = await client.call("settings.preview", {
			baseRevision: original.revision,
			settings: proposed,
		});
		expect(sealed.snapshot.length).toBeGreaterThan(24000);
		expect(sealed.digest).toBe(digest(sealed.snapshot));
		expect(JSON.parse(sealed.snapshot).settings).toEqual(proposed);
		expect(sealed.snapshot).not.toContain("not-projected-private-field");
		expect(fs.readFileSync(file).equals(before)).toBe(true);
		await expect(
			client.call("settings.apply", {
				id: sealed.id,
				approval: `approve:${sealed.digest}\n`,
			}),
		).rejects.toThrow("Native operation refused");
		expect(fs.readFileSync(file).equals(before)).toBe(true);
		await client.call("settings.apply", {
			id: sealed.id,
			approval: `approve:${sealed.digest}`,
		});
		const observed = await client.call("settings.read", {});
		expect(observed.settings).toEqual(proposed);
		expect(observed.revision).toBe(digest(fs.readFileSync(file)));
		expect(JSON.parse(fs.readFileSync(file, "utf8")).privateExtra).toEqual({
			fixture: "not-projected-private-field",
		});
		expect({
			profiles: config.profiles,
			repositories: config.repositories,
			providers: config.providers,
		}).toEqual(running);
		expect((await client.call("state.read", {})).tasks).toEqual([]);
		await expect(
			client.call("settings.preview", {
				baseRevision: observed.revision,
				settings: {
					...proposed,
					providers: [...proposed.providers, proposed.providers[0]],
				} as SettingsDefinition,
			}),
		).rejects.toThrow("Native operation refused");
		expect(digest(fs.readFileSync(file))).toBe(observed.revision);
	} finally {
		client.close();
		await host.stop();
	}
});

test("authenticated settings preview/save is exact, disk-fenced and never changes live authority", async () => {
	const { app, config } = await fixture();
	const host = serve(app),
		client = new ClientConnection(host.client);
	const file = path.join(config.configDir, "config.json");
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const initial = await client.call("settings.read", {});
		expect(initial.revision).toBe("missing");
		expect(fs.existsSync(config.configDir)).toBe(false);
		const proposed: SettingsDefinition = structuredClone(initial.settings);
		proposed.profiles.test = {
			...proposed.profiles.test,
			model: `${config.profiles[0]?.provider}/replacement`,
			description: "Updated native settings",
		};
		proposed.providers = [
			{
				name: "gitlab",
				type: "gitlab",
				baseUrl: "https://gitlab.example.invalid",
				tokenRef: "TEST_PROVIDER_TOKEN",
			},
		];
		const candidate = await client.call("settings.preview", {
			baseRevision: initial.revision,
			settings: proposed,
		});
		expect(candidate.digest).toBe(digest(candidate.snapshot));
		expect(JSON.parse(candidate.snapshot)).toEqual({
			baseRevision: "missing",
			settings: proposed,
		});
		expect(fs.existsSync(config.configDir)).toBe(false);
		await expect(
			client.call("settings.apply", {
				id: candidate.id,
				approval: `approve:${"0".repeat(64)}`,
			}),
		).rejects.toThrow("Native operation refused");
		expect(fs.existsSync(config.configDir)).toBe(false);
		const receipt = await client.call("settings.apply", {
			id: candidate.id,
			approval: `approve:${candidate.digest}`,
		});
		expect(receipt.restartRequired).toBe(true);
		expect(receipt.revision).toBe(digest(fs.readFileSync(file)));
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(config.profiles[0]?.modelId).toBe("original");
		expect(config.providers).toEqual([]);
		const loaded = loadConfig(
			config.stateDir,
			config.repositories[0] ?? "",
			config.configDir,
		);
		expect(loaded.profiles[0]?.modelId).toBe("replacement");
		expect(loaded.providers[0]?.tokenRef).toBe("TEST_PROVIDER_TOKEN");
		await expect(
			client.call("settings.apply", {
				id: candidate.id,
				approval: `approve:${candidate.digest}`,
			}),
		).rejects.toThrow("Native operation refused");
		const opaque = {
			...JSON.parse(fs.readFileSync(file, "utf8")),
			privateExtra: { token: "stub-hidden" },
		};
		fs.writeFileSync(file, JSON.stringify(opaque));
		const observed = await client.call("settings.read", {});
		expect(JSON.stringify(observed)).not.toContain("stub-hidden");
		const update = await client.call("settings.preview", {
			baseRevision: observed.revision,
			settings: observed.settings,
		});
		expect(update.snapshot).not.toContain("stub-hidden");
		const externallyEdited = `${JSON.stringify(opaque)}\n`;
		fs.writeFileSync(file, externallyEdited);
		await expect(
			client.call("settings.apply", {
				id: update.id,
				approval: `approve:${update.digest}`,
			}),
		).rejects.toThrow("Native operation refused");
		expect(fs.readFileSync(file, "utf8")).toBe(externallyEdited);
		const latest = await client.call("settings.read", {});
		const final = await client.call("settings.preview", {
			baseRevision: latest.revision,
			settings: latest.settings,
		});
		await client.call("settings.apply", {
			id: final.id,
			approval: `approve:${final.digest}`,
		});
		expect(JSON.parse(fs.readFileSync(file, "utf8")).privateExtra).toEqual({
			token: "stub-hidden",
		});
		const malformed = {
			...latest.settings,
			providers: [{ ...proposed.providers[0], token: "never write this" }],
		} as unknown as SettingsDefinition;
		const saved = await client.call("settings.read", {});
		await expect(
			client.call("settings.preview", {
				baseRevision: saved.revision,
				settings: malformed,
			}),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("settings.preview", {
				baseRevision: saved.revision,
				settings: {
					...saved.settings,
					providers: [
						{
							name: "insecure",
							type: "gitlab",
							baseUrl: "http://remote.example.invalid",
							tokenRef: "TOKEN",
						},
					],
				},
			}),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("settings.preview", {
				baseRevision: saved.revision,
				settings: {
					...saved.settings,
					providers: [
						{
							name: "badref",
							type: "gitlab",
							baseUrl: "https://remote.example.invalid",
							tokenRef: "TOKEN\n",
						},
					],
				},
			}),
		).rejects.toThrow("Native operation refused");
		expect(digest(fs.readFileSync(file))).toBe(saved.revision);
		// Fixed target never follows an externally substituted config-file symlink.
		const target = path.join(config.configDir, "external.json");
		fs.renameSync(file, target);
		fs.symlinkSync(target, file);
		await expect(client.call("settings.read", {})).rejects.toThrow(
			"Native operation refused",
		);
		expect(digest(fs.readFileSync(target))).toBe(saved.revision);
	} finally {
		client.close();
		await host.stop();
	}
});

test("direct operator settings save is revision-bound, private and does not bypass candidate approval", async () => {
	const { app, config } = await fixture();
	const host = serve(app),
		client = new ClientConnection(host.client);
	const file = path.join(config.configDir, "config.json");
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const initial = await client.call("settings.read", {});
		const settings = structuredClone(initial.settings);
		settings.profiles.test = {
			...settings.profiles.test,
			model: `${config.profiles[0]?.provider}/operator-choice`,
		};
		const candidate = await client.call("settings.preview", {
			baseRevision: initial.revision,
			settings,
		});
		await expect(
			client.call("settings.apply", {
				id: candidate.id,
				approval: "operator-click",
			}),
		).rejects.toThrow("Native operation refused");
		expect(fs.existsSync(file)).toBe(false);
		const receipt = await client.call("settings.save", {
			baseRevision: initial.revision,
			settings,
		});
		expect(receipt.restartRequired).toBe(true);
		expect(receipt.revision).toBe(digest(fs.readFileSync(file)));
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(config.profiles[0]?.modelId).toBe("original");
		const saved = await client.call("settings.read", {});
		expect(saved.settings).toEqual(settings);
		// Neither an old direct action nor an approved old candidate may overwrite
		// the revision just saved. No automatic retry/adoption is performed.
		await expect(
			client.call("settings.save", {
				baseRevision: initial.revision,
				settings: initial.settings,
			}),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("settings.apply", {
				id: candidate.id,
				approval: `approve:${candidate.digest}`,
			}),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("settings.save", {
				baseRevision: saved.revision,
				settings: {
					...settings,
					providers: [
						{
							name: "bad",
							type: "gitlab",
							baseUrl: "http://remote.invalid",
							tokenRef: "REFERENCE_ONLY",
						},
					],
				},
			}),
		).rejects.toThrow("Native operation refused");
		expect(digest(fs.readFileSync(file))).toBe(receipt.revision);
		// Foreign disk keys survive a direct operator save without being exposed.
		fs.writeFileSync(
			file,
			JSON.stringify({ ...settings, opaque: { retained: true } }),
		);
		const foreign = await client.call("settings.read", {});
		expect(JSON.stringify(foreign)).not.toContain("opaque");
		await client.call("settings.save", {
			baseRevision: foreign.revision,
			settings: foreign.settings,
		});
		expect(JSON.parse(fs.readFileSync(file, "utf8")).opaque).toEqual({
			retained: true,
		});
	} finally {
		client.close();
		await host.stop();
		await app.close();
	}
});
