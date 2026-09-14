// Environment ownership boundaries (port-project-catalog-and-state-to-bun,
// task 4.2). Bun owning the environment state must not reach into the workflow
// or telemetry domains, and no second environment-state writer may exist: these
// are asserted over both the runtime behavior and the source boundary.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvironmentAuthority } from "../src/server/environment/authority.ts";
import { executeEnvironmentOperation } from "../src/server/environment/private-api.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures", "environment");
const SOURCE = path.join(import.meta.dir, "..", "src");

/** Every source file that opens a SQLite database, with the domain it serves. */
function sqliteOwners(): Array<{ file: string; domain: string }> {
	const owners: Array<{ file: string; domain: string }> = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const target = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(target);
				continue;
			}
			if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
			const content = fs.readFileSync(target, "utf8");
			if (!content.includes("bun:sqlite")) continue;
			const relative = path.relative(SOURCE, target).split(path.sep).join("/");
			owners.push({ file: relative, domain: sqliteOwners_domain(relative) });
		}
	};
	walk(SOURCE);
	return owners;
}

function sqliteOwners_domain(relative: string): string {
	// The environment database has exactly one owner module.
	if (relative.startsWith("server/environment/")) return "environment";
	if (relative.startsWith("server/")) return "telemetry";
	if (relative.startsWith("tui/otel/")) return "telemetry";
	if (relative.startsWith("workflow/")) return "workflow";
	return "other";
}

describe("environment state has one owner", () => {
	test("only the environment module opens the environment database", () => {
		const owners = sqliteOwners();
		const environmentOwners = owners
			.filter((entry) => entry.domain === "environment")
			.map((entry) => entry.file);
		expect(environmentOwners).toEqual(["server/environment/state-store.ts"]);
		// The other domains keep their own, separate databases.
		expect(owners.length).toBeGreaterThan(1);
		expect(owners.some((entry) => entry.domain === "workflow")).toBe(true);
		expect(owners.some((entry) => entry.domain === "telemetry")).toBe(true);
	});

	test("no workflow or telemetry module imports the environment state store", () => {
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const target = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(target);
					continue;
				}
				if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx"))
					continue;
				const relative = path
					.relative(SOURCE, target)
					.split(path.sep)
					.join("/");
				if (relative.startsWith("server/environment/")) continue;
				const content = fs.readFileSync(target, "utf8");
				if (
					/content from "\.\.?\/.*environment\/(state-store|manager|private-api)\.ts"/.test(
						content,
					)
				)
					offenders.push(relative);
			}
		};
		walk(SOURCE);
		expect(offenders).toEqual([]);
	});
});

describe("the environment authority stays inside its domain", () => {
	test("owning the environment creates only the environment database", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-domain-"));
		const home = path.join(dir, "home");
		const configDir = path.join(dir, "config");
		fs.mkdirSync(home, { recursive: true });
		fs.cpSync(path.join(FIXTURES, "config", "contract-apps"), configDir, {
			recursive: true,
		});
		// A pre-existing workflow store and telemetry database next to the
		// environment database: neither may be opened, migrated or rewritten.
		const workflowStore = path.join(home, "workflows", "herdr.db");
		const telemetryStore = path.join(home, "telemetry", "traces.db");
		fs.mkdirSync(path.dirname(workflowStore), { recursive: true });
		fs.mkdirSync(path.dirname(telemetryStore), { recursive: true });
		fs.writeFileSync(workflowStore, "workflow store bytes");
		fs.writeFileSync(telemetryStore, "telemetry store bytes");
		try {
			const authority = createEnvironmentAuthority({
				homeDir: home,
				configDir,
			});
			try {
				executeEnvironmentOperation(authority, {
					operation: "state.setBranch",
					params: { ident: "alpha", branch: "feature/x" },
				});
				executeEnvironmentOperation(authority, {
					operation: "manager.loadConfig",
					params: {},
				});
				expect(fs.readFileSync(workflowStore, "utf8")).toBe(
					"workflow store bytes",
				);
				expect(fs.readFileSync(telemetryStore, "utf8")).toBe(
					"telemetry store bytes",
				);
				// The only database this authority created is the environment one
				// (plus its own WAL sidecars).
				expect(
					fs
						.readdirSync(path.join(home, "db"))
						.filter((entry) => entry.startsWith("state.db"))
						.sort(),
				).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
			} finally {
				authority.state.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
