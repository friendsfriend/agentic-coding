import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigurationMutation } from "../src/domain/configuration-write.ts";
import { createConfigurationWriteService } from "../src/services/configuration-write-service.ts";

function fixture() {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-write-")),
	);
	const repository = path.join(root, "repo");
	const configDir = path.join(root, "config");
	fs.mkdirSync(repository);
	fs.mkdirSync(configDir, { mode: 0o700 });
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ repositories: [repository] }),
	);
	const environments = path.join(configDir, "environments.json");
	fs.writeFileSync(
		environments,
		`${JSON.stringify(
			{
				version: 1,
				projects: [
					{
						id: "app-a",
						kind: "app",
						repository,
						defaults: { build: "build" },
						targets: [
							{
								id: "build",
								action: "build",
								runtime: "shell",
								command: "echo build",
							},
						],
					},
				],
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	return { root, repository, configDir, environments };
}

function serviceFor(configDir: string, repository: string) {
	let refreshes = 0;
	const service = createConfigurationWriteService({
		configDir,
		repositories: [repository],
		refresh: () => {
			refreshes++;
			return { refreshed: true };
		},
	});
	return { service, refreshes: () => refreshes };
}

async function apply(
	service: ReturnType<typeof createConfigurationWriteService>,
	mutation: ConfigurationMutation,
) {
	const preview = service.preview(mutation);
	expect(preview.status).toBe("confirmation-required");
	return await service.apply(mutation, preview.expectedDigest, preview.confirm);
}

test("configuration writes preview, validate, back up and refresh", async () => {
	const { root, repository, configDir, environments } = fixture();
	const { service, refreshes } = serviceFor(configDir, repository);
	try {
		const before = service.revision();
		const mutation: ConfigurationMutation = {
			operation: "app-create",
			app: { id: "app-b", kind: "library", repository },
		};
		const preview = service.preview(mutation);
		expect(preview).toMatchObject({
			status: "confirmation-required",
			expectedDigest: before.digest,
		});
		expect(service.revision().digest).toBe(before.digest);
		expect(fs.readFileSync(environments, "utf8")).not.toContain("app-b");

		const mismatch = await service.apply(
			mutation,
			preview.expectedDigest,
			"0".repeat(64),
		);
		expect(mismatch).toMatchObject({ status: "confirmation-required" });
		expect(service.revision().digest).toBe(before.digest);

		const completed = await service.apply(
			mutation,
			preview.expectedDigest,
			preview.confirm,
		);
		expect(completed).toMatchObject({ status: "completed" });
		expect(service.revision()).toMatchObject({ apps: 2, targets: 1 });
		expect(fs.readFileSync(environments, "utf8")).toContain("app-b");
		expect(
			fs
				.readdirSync(configDir)
				.some((entry) => entry.startsWith("environments.json.mcp-bak-")),
		).toBe(true);
		expect(refreshes()).toBe(1);

		await expect(
			service.apply(mutation, preview.expectedDigest, preview.confirm),
		).rejects.toMatchObject({ code: "config-stale" });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("app and target CRUD enforce defaults and references", async () => {
	const { root, repository, configDir, environments } = fixture();
	const { service } = serviceFor(configDir, repository);
	try {
		await expect(
			apply(service, {
				operation: "app-create",
				app: { id: "unauthorized", repository: "/outside" },
			}),
		).rejects.toMatchObject({ code: "config-invalid" });

		await apply(service, {
			operation: "target-create",
			mode: "duplicate",
			app: "app-a",
			sourceApp: "app-a",
			sourceTarget: "build",
			id: "build-qa",
			profile: "qa",
		});
		expect(service.revision().targets).toBe(2);

		await apply(service, {
			operation: "target-update",
			app: "app-a",
			id: "build-qa",
			profile: "review",
			timeoutSec: 30,
		});
		expect(fs.readFileSync(environments, "utf8")).toContain(
			'"profile": "review"',
		);

		await apply(service, {
			operation: "target-create",
			mode: "shell",
			app: "app-a",
			id: "run",
			action: "run",
			command: "sleep 1",
		});
		await apply(service, {
			operation: "target-update",
			app: "app-a",
			id: "run",
			prerequisites: [{ app: "app-a", target: "build" }],
		});

		await expect(
			apply(service, {
				operation: "target-delete",
				app: "app-a",
				id: "build",
			}),
		).rejects.toMatchObject({ code: "target-is-default" });

		await apply(service, {
			operation: "app-update",
			id: "app-a",
			defaults: {},
		});
		await expect(
			apply(service, {
				operation: "target-delete",
				app: "app-a",
				id: "build",
			}),
		).rejects.toMatchObject({ code: "target-referenced" });

		await apply(service, {
			operation: "target-delete",
			app: "app-a",
			id: "run",
		});
		await apply(service, {
			operation: "target-delete",
			app: "app-a",
			id: "build",
		});
		expect(service.revision().targets).toBe(1);

		await apply(service, {
			operation: "app-create",
			app: { id: "app-b", repository },
		});
		await apply(service, {
			operation: "target-create",
			mode: "shell",
			app: "app-b",
			id: "test",
			action: "test",
			command: "echo test",
			profile: "ci",
		});
		await expect(
			apply(service, {
				operation: "app-delete",
				id: "app-b",
				deleteTargets: false,
			}),
		).rejects.toMatchObject({ code: "app-has-targets" });
		await apply(service, {
			operation: "app-delete",
			id: "app-b",
			deleteTargets: true,
		});
		expect(fs.readFileSync(environments, "utf8")).not.toContain('"app-b"');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
