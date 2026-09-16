// Environment ownership boundaries (port-project-catalog-and-state-to-bun,
// task 4.2). Bun owning the environment state must not reach into the workflow
// or telemetry domains, and no second environment-state writer may exist: these
// are asserted over both the runtime behavior and the source boundary.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSourceAnalysis } from "../scripts/workflow-module-graph.ts";
import { createEnvironmentAuthority } from "../src/server/environment/authority.ts";
import { executeEnvironmentOperation } from "../src/server/environment/private-api.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures", "environment");
const SOURCE = path.join(import.meta.dir, "..", "src");

/** Domains that must not reach into the environment state. */
const RESTRICTED_PREFIXES = ["workflow/", "tui/otel/"];

/** Environment modules only the composition root (`src/server/**`) may wire up. */
const ENVIRONMENT_INTERNALS = [
	"state-store.ts",
	"manager.ts",
	"private-api.ts",
];

/** Resolved dependency edges from restricted modules into environment internals.
 * Edges come from the TypeScript source graph, so a renamed binding, re-export,
 * type-only reference, or literal dynamic/require form is still an edge; each
 * offender names its source (with position and form) and its dependency. */
function environmentOwnershipOffenders(root: string): string[] {
	const restrictedTargets = new Set(
		ENVIRONMENT_INTERNALS.map((name) =>
			path.join(root, "server", "environment", name),
		),
	);
	const offenders: string[] = [];
	for (const [file, module] of buildSourceAnalysis(root)) {
		const relative = path.relative(root, file).split(path.sep).join("/");
		if (!RESTRICTED_PREFIXES.some((prefix) => relative.startsWith(prefix)))
			continue;
		for (const edge of module.edges) {
			if (!edge.resolved || !restrictedTargets.has(edge.resolved)) continue;
			const target = path
				.relative(root, edge.resolved)
				.split(path.sep)
				.join("/");
			offenders.push(
				`${relative}:${edge.line}:${edge.column} ${edge.kind}${edge.typeOnly ? " type-only" : ""} import of ${target}`,
			);
		}
	}
	return offenders;
}

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

	test("no workflow or telemetry module depends on the environment internals", () => {
		// Composition-root access (`src/server/**`) is deliberately out of scope:
		// those modules legitimately own the authority wiring.
		expect(environmentOwnershipOffenders(SOURCE)).toEqual([]);
	});

	test("the guard rejects every supported import form and keeps the composition root allowed", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "env-ownership-"));
		const write = (relative: string, content: string): void => {
			const file = path.join(root, relative);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
		};
		try {
			for (const name of ENVIRONMENT_INTERNALS)
				write(`server/environment/${name}`, "export const stub = 1;\n");
			write(
				"workflow/named.ts",
				'import { stub } from "../server/environment/state-store.ts";\n',
			);
			write(
				"workflow/reexport.ts",
				'export { stub } from "../server/environment/manager.ts";\n',
			);
			write(
				"workflow/type-only.ts",
				'import type { stub } from "../server/environment/private-api.ts";\n',
			);
			write(
				"workflow/dynamic.ts",
				'export const load = () => import("../server/environment/state-store.ts");\n',
			);
			write(
				"workflow/require.ts",
				'export const loaded = require("../server/environment/manager.ts");\n',
			);
			write("workflow/clean.ts", 'import { helper } from "./helper.ts";\n');
			write("workflow/helper.ts", "export const helper = 1;\n");
			// Allowed composition-root client of the same modules.
			write(
				"server/app.ts",
				'import { stub } from "./environment/state-store.ts";\n',
			);

			const offenders = environmentOwnershipOffenders(root);
			for (const file of [
				"named",
				"reexport",
				"type-only",
				"dynamic",
				"require",
			])
				expect(
					offenders.some((entry) => entry.startsWith(`workflow/${file}.ts:`)),
				).toBe(true);
			expect(
				offenders.some((entry) => entry.includes("workflow/clean.ts")),
			).toBe(false);
			expect(offenders.some((entry) => entry.includes("server/app.ts"))).toBe(
				false,
			);

			// Each offender names its source, position, import form, and dependency.
			expect(
				offenders.find((entry) => entry.startsWith("workflow/named.ts:")),
			).toContain("static import of server/environment/state-store.ts");
			expect(
				offenders.find((entry) => entry.startsWith("workflow/type-only.ts:")),
			).toContain("type-only import of server/environment/private-api.ts");
			expect(
				offenders.find((entry) => entry.startsWith("workflow/dynamic.ts:")),
			).toContain("dynamic import of server/environment/state-store.ts");
			expect(
				offenders.find((entry) => entry.startsWith("workflow/require.ts:")),
			).toContain("require import of server/environment/manager.ts");
			expect(
				offenders.find((entry) => entry.startsWith("workflow/reexport.ts:")),
			).toContain("static import of server/environment/manager.ts");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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
