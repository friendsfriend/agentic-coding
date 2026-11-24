import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConfigurationRefresh } from "../src/services/configuration-refresh.ts";

test("refresh publishes complete definitions only when idle and authorization is unchanged", () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-refresh-")),
	);
	const repository = path.join(root, "repo");
	fs.mkdirSync(repository);
	const config = path.join(root, "config.json");
	const definitions = path.join(root, "environments.json");
	fs.writeFileSync(config, JSON.stringify({ repositories: [repository] }));
	const write = (id: string) =>
		fs.writeFileSync(
			definitions,
			JSON.stringify({
				version: 1,
				projects: [{ id, repository, targets: [] }],
			}),
		);
	let idle = true;
	let published = "original";
	const refresh = createConfigurationRefresh({
		configDir: root,
		repositories: [repository],
		isIdle: () => idle,
		apply: (next) => {
			published = next.apps[0]?.id ?? "missing";
		},
	});
	try {
		write("updated");
		expect(refresh()).toMatchObject({
			refreshed: true,
			secretsReloaded: false,
		});
		expect(published).toBe("updated");
		idle = false;
		write("blocked");
		expect(refresh).toThrow("configuration-busy");
		expect(published).toBe("updated");
		idle = true;
		fs.writeFileSync(definitions, "invalid private content");
		expect(refresh).toThrow("configuration-refresh-invalid");
		expect(published).toBe("updated");
		write("blocked");
		fs.writeFileSync(
			config,
			JSON.stringify({ repositories: [repository, root] }),
		);
		expect(refresh).toThrow("configuration-refresh-invalid");
		expect(published).toBe("updated");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
