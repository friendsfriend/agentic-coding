// Explicit configuration migration (unify-json-configuration-directory,
// tasks 4.1-4.4 / 6.1) plus the credential-extraction fixtures for task 3.3.
// Every case runs against temporary directories; no test touches real user
// configuration or real secrets.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	applyMigration,
	formatMigrationPlan,
	legacyEnvRoot,
	planMigration,
	resumeMigration,
	rollbackMigration,
} from "../src/config-migration.ts";
import { CONFIG_ROOT_VAR, migrationJournalPath } from "../src/config-root.ts";
import { loadEnvFile } from "../src/env-file.ts";
import { loadConfigWithProvenance } from "../src/workflow/effects.ts";

function sha256File(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** A fixture pair of roots that never touches real user configuration. */
function fixture(): {
	dir: string;
	source: string;
	target: string;
	home: string;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-migration-"));
	const source = path.join(dir, "devenv");
	const target = path.join(dir, "agentic-coding");
	const home = path.join(dir, "home");
	fs.mkdirSync(source, { recursive: true });
	fs.mkdirSync(target, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	return { dir, source, target, home };
}

function write(file: string, content: string, mode = 0o644): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, { mode });
}

const LEGACY_TOML = `[workflow]
max_verification_rounds = 20
remote = "origin"
branch_prefix = "feature/"
base_branch = "origin/HEAD"

[agents]
default_profile = "pi-a"

[agents.profiles.pi-a]
runtime = "pi"
model = "a/b"

[ui]
theme = "catppuccin"
herdr_sidebar = true
`;

describe("configuration migration preview", () => {
	test("a fresh machine has nothing to do", () => {
		const f = fixture();
		try {
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.actions).toEqual([]);
			expect(plan.conflicts).toEqual([]);
			expect(formatMigrationPlan(plan)).toContain("nothing to do");
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("the preview writes nothing", () => {
		const f = fixture();
		try {
			write(path.join(f.target, "config.toml"), LEGACY_TOML);
			write(path.join(f.source, ".env"), "GITHUB_TOKEN=secret-value\n");
			const before = fs.readdirSync(f.target).sort();
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.actions.length).toBe(2);
			expect(fs.readdirSync(f.target).sort()).toEqual(before);
			expect(fs.existsSync(path.join(f.target, "config.json"))).toBe(false);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("reports credential variable names and never their values", () => {
		const f = fixture();
		try {
			write(
				path.join(f.source, ".env"),
				"GITHUB_TOKEN=ghp_super_secret_value\nDEVENV_HOME=/tmp/home\n",
			);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			const rendered = formatMigrationPlan(plan);
			expect(plan.secretKeyNames).toEqual(["DEVENV_HOME", "GITHUB_TOKEN"]);
			expect(rendered).toContain("GITHUB_TOKEN");
			expect(rendered).not.toContain("ghp_super_secret_value");
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a differing .env value for one key is a conflict, never last-write-wins", () => {
		const f = fixture();
		try {
			write(path.join(f.source, ".env"), "GITHUB_TOKEN=from-source\n");
			write(path.join(f.target, ".env"), "GITHUB_TOKEN=from-target\n");
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts.map((conflict) => conflict.kind)).toEqual([
				"env-value",
			]);
			const rendered = formatMigrationPlan(plan);
			expect(rendered).toContain("GITHUB_TOKEN");
			expect(rendered).not.toContain("from-source");
			expect(rendered).not.toContain("from-target");
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a duplicate definition ident across roots is a conflict", () => {
		const f = fixture();
		try {
			write(
				path.join(f.source, "apps", "definitions", "one.json"),
				'{ "ident": "checkout", "displayName": "Source" }\n',
			);
			write(
				path.join(f.target, "apps", "definitions", "two.json"),
				'{ "ident": "checkout", "displayName": "Target" }\n',
			);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts.map((conflict) => conflict.kind)).toContain(
				"duplicate-ident",
			);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("an unsupported TOML value is reported instead of converted lossily", () => {
		const f = fixture();
		try {
			write(
				path.join(f.target, "config.toml"),
				'[workflow]\nreleased = 2026-01-02T03:04:05Z\nremote = "origin"\n',
			);
			let plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts.map((conflict) => conflict.kind)).toEqual([
				"unsupported-value",
			]);
			expect(plan.actions).toEqual([]);
			// A non-finite number cannot round-trip either.
			write(
				path.join(f.target, "config.toml"),
				'[workflow]\nratio = inf\nremote = "origin"\n',
			);
			plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts.map((conflict) => conflict.kind)).toEqual([
				"unsupported-value",
			]);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a symlinked source is refused rather than followed", () => {
		const f = fixture();
		try {
			const real = path.join(f.dir, "real.toml");
			write(real, LEGACY_TOML);
			fs.symlinkSync(real, path.join(f.target, "config.toml"));
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts.map((conflict) => conflict.kind)).toContain(
				"symlink",
			);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("an existing config.json wins over a leftover TOML source", () => {
		const f = fixture();
		try {
			write(path.join(f.target, "config.toml"), LEGACY_TOML);
			write(
				path.join(f.target, "config.json"),
				'{ "ui": { "theme": "dracula" } }\n',
			);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.actions).toEqual([]);
			expect(plan.skipped.map((skip) => skip.reason).join(" ")).toContain(
				"already exists and wins",
			);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("runtime data and the knowledge wiki are never migrated", () => {
		const f = fixture();
		try {
			write(
				path.join(f.source, "logs", "infrastructure", "a.log"),
				"log line\n",
			);
			write(path.join(f.source, "wiki", "index.md"), "# knowledge\n");
			write(path.join(f.source, "unknown-thing"), "keep me\n");
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.actions).toEqual([]);
			const reasons = plan.skipped.map(
				(skip) => `${skip.path}: ${skip.reason}`,
			);
			expect(reasons.join("\n")).toContain("runtime data; stays in place");
			expect(reasons.join("\n")).toContain("unrecognized entry");
			// The wiki is knowledge data, not configuration: it is not a migrated asset.
			expect(reasons.join("\n")).toContain("wiki");
			expect(fs.existsSync(path.join(f.target, "wiki"))).toBe(false);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("configuration migration apply", () => {
	test("converts the workflow config, preserves parity and keeps the source", () => {
		const f = fixture();
		try {
			const legacy = path.join(f.target, "config.toml");
			write(legacy, LEGACY_TOML);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			const result = applyMigration(plan);
			expect(result.applied).toBe(1);

			const converted = JSON.parse(
				fs.readFileSync(path.join(f.target, "config.json"), "utf8"),
			) as Record<string, unknown>;
			expect(converted).toMatchObject({
				workflow: { max_verification_rounds: 20, remote: "origin" },
				agents: { default_profile: "pi-a" },
				ui: { theme: "catppuccin", herdr_sidebar: true },
			});
			// Original sources stay in place and byte-identical.
			expect(fs.readFileSync(legacy, "utf8")).toBe(LEGACY_TOML);
			// A protected backup exists (an audit copy of the source plus the
			// replaced target) and the journal is gone.
			expect(fs.existsSync(result.backupDir as string)).toBe(true);
			expect(fs.existsSync(migrationJournalPath(f.target))).toBe(false);
			const backupDir = result.backupDir as string;
			expect(fs.readdirSync(path.join(backupDir, "sources"))).toEqual([
				"0-config.toml",
			]);
			// The converted target did not exist before, so there is nothing to restore
			// and a rollback removes it instead.
			expect(fs.readdirSync(path.join(backupDir, "targets"))).toEqual([]);
			// The effective configuration is unchanged by the conversion.
			process.env[CONFIG_ROOT_VAR] = f.target;
			try {
				const resolved = loadConfigWithProvenance({
					repositoryIndependent: true,
				});
				expect(resolved.config.workflow.remote).toBe("origin");
				expect(resolved.config.ui.herdr_sidebar).toBe(true);
				expect(resolved.provenance.source).toBe("user");
			} finally {
				delete process.env[CONFIG_ROOT_VAR];
			}
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("moves environment configuration and leaves runtime data alone", () => {
		const f = fixture();
		try {
			write(path.join(f.source, ".env"), "DEVENV_HOME=/tmp/dh\n", 0o644);
			write(
				path.join(f.source, "apps", "definitions", "one.json"),
				'{ "ident": "checkout" }\n',
			);
			write(
				path.join(f.source, "providers", "github.json"),
				'{ "name": "gh" }\n',
				0o600,
			);
			write(path.join(f.source, "tui.json"), '{ "theme": "dracula" }\n');
			write(path.join(f.source, "logs", "infrastructure", "a.log"), "log\n");
			write(path.join(f.source, "wiki", "index.md"), "# knowledge\n");

			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts).toEqual([]);
			applyMigration(plan);

			expect(
				fs.existsSync(path.join(f.target, "apps", "definitions", "one.json")),
			).toBe(true);
			expect(
				fs.existsSync(path.join(f.target, "providers", "github.json")),
			).toBe(true);
			expect(
				fs.readFileSync(path.join(f.target, "tui.json"), "utf8"),
			).toContain("dracula");
			// Secret-bearing files are owner-only.
			expect(fs.statSync(path.join(f.target, ".env")).mode & 0o777).toBe(0o600);
			// Runtime data did not move.
			expect(fs.existsSync(path.join(f.target, "logs"))).toBe(false);
			expect(fs.existsSync(path.join(f.target, "wiki"))).toBe(false);
			expect(
				fs.existsSync(path.join(f.source, "logs", "infrastructure", "a.log")),
			).toBe(true);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test(".env merges only missing keys and never rewrites an existing value", () => {
		const f = fixture();
		try {
			write(path.join(f.source, ".env"), "NEW_KEY=from-source\nKEPT=same\n");
			write(path.join(f.target, ".env"), "KEPT=same\nTARGET_ONLY=kept\n");
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts).toEqual([]);
			expect(plan.actions.map((action) => action.kind)).toEqual(["merge-env"]);
			applyMigration(plan);
			const merged = fs.readFileSync(path.join(f.target, ".env"), "utf8");
			expect(merged).toContain("NEW_KEY=from-source");
			expect(merged).toContain("TARGET_ONLY=kept");
			expect(merged.match(/KEPT=/g)?.length).toBe(1);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a conflict blocks apply instead of writing", () => {
		const f = fixture();
		try {
			write(path.join(f.source, ".env"), "GITHUB_TOKEN=from-source\n");
			write(path.join(f.target, ".env"), "GITHUB_TOKEN=from-target\n");
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(() => applyMigration(plan)).toThrow(/conflict/);
			expect(fs.readFileSync(path.join(f.target, ".env"), "utf8")).toContain(
				"from-target",
			);
			expect(fs.existsSync(migrationJournalPath(f.target))).toBe(false);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a rerun is idempotent and preserves later canonical edits", () => {
		const f = fixture();
		try {
			write(path.join(f.target, "config.toml"), LEGACY_TOML);
			applyMigration(
				planMigration({ source: f.source, target: f.target, home: f.home }),
			);
			const canonical = path.join(f.target, "config.json");
			const edited = `${JSON.stringify(
				{
					...(JSON.parse(fs.readFileSync(canonical, "utf8")) as object),
					extra: true,
				},
				null,
				2,
			)}\n`;
			write(canonical, edited);

			const rerun = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(rerun.actions).toEqual([]);
			expect(applyMigration(rerun).applied).toBe(0);
			expect(fs.readFileSync(canonical, "utf8")).toContain('"extra": true');
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("external credential stores stay external", () => {
	test("harness authentication is never imported or persisted", () => {
		const f = fixture();
		try {
			// External harness credential stores live outside the configuration roots;
			// the migration must not read, move or copy them.
			write(
				path.join(f.home, ".pi", "agent", "auth.json"),
				'{ "token": "harness-secret" }\n',
				0o600,
			);
			write(
				path.join(f.home, ".config", "opencode", "auth.json"),
				'{ "key": "other-harness-secret" }\n',
				0o600,
			);
			write(
				path.join(f.source, ".env"),
				"GITHUB_TOKEN=provider-secret\n",
				0o600,
			);

			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			const rendered = formatMigrationPlan(plan);
			expect(rendered).not.toContain("harness-secret");
			expect(rendered).not.toContain("other-harness-secret");
			expect(rendered).not.toContain("provider-secret");
			expect(
				plan.actions.some((action) => action.from.includes("auth.json")),
			).toBe(false);

			applyMigration(plan);
			// Only the root `.env` and declarations moved; no harness store did.
			const copied = fs
				.readdirSync(f.target, { recursive: true })
				.map((entry) => String(entry));
			expect(copied.some((entry) => entry.includes("auth.json"))).toBe(false);
			expect(copied.some((entry) => entry.includes("opencode"))).toBe(false);
			// The harness stores are untouched where they live.
			expect(
				fs.readFileSync(path.join(f.home, ".pi", "agent", "auth.json"), "utf8"),
			).toContain("harness-secret");
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("failed writes", () => {
	test("a failed publication leaves every live file unchanged", () => {
		const f = fixture();
		try {
			write(path.join(f.target, "config.toml"), LEGACY_TOML);
			const before = fs.readFileSync(
				path.join(f.target, "config.toml"),
				"utf8",
			);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			// Block the staged write for `config.json` while the source stays readable.
			// Nothing has been published at that point, so the failure is pre-publication.
			fs.mkdirSync(path.join(f.target, "config.json.staged"));
			try {
				expect(() => applyMigration(plan)).toThrow();
			} finally {
				fs.rmSync(path.join(f.target, "config.json.staged"), {
					recursive: true,
					force: true,
				});
			}
			// No published file, no leftover staged file, no journal.
			expect(fs.readFileSync(path.join(f.target, "config.toml"), "utf8")).toBe(
				before,
			);
			expect(fs.existsSync(path.join(f.target, "config.json"))).toBe(false);
			expect(fs.existsSync(migrationJournalPath(f.target))).toBe(false);
			const leftovers = fs
				.readdirSync(f.target, { recursive: true })
				.map((entry) => String(entry))
				.filter((entry) => entry.endsWith(".staged"));
			expect(leftovers).toEqual([]);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("interrupted migration recovery", () => {
	test("a pending journal blocks configuration reads until it is resumed", () => {
		const f = fixture();
		try {
			write(path.join(f.target, "config.toml"), LEGACY_TOML);
			process.env[CONFIG_ROOT_VAR] = f.target;
			try {
				applyMigration(
					planMigration({ source: f.source, target: f.target, home: f.home }),
				);
				// Simulate a cutover that stopped mid-publication.
				const journal = {
					version: 1,
					state: "preparing",
					createdAt: new Date().toISOString(),
					targetRoot: f.target,
					backupDir: path.join(f.target, ".config-backup", "x"),
					sources: [],
					targets: [],
					secretKeys: [],
				};
				fs.writeFileSync(
					migrationJournalPath(f.target),
					`${JSON.stringify(journal)}\n`,
				);
				expect(() =>
					loadConfigWithProvenance({ repositoryIndependent: true }),
				).toThrow(/migration .* is incomplete/);
				expect(resumeMigration(f.target)).toBe(0);
				expect(
					loadConfigWithProvenance({ repositoryIndependent: true }).config.ui
						.herdr_sidebar,
				).toBe(true);
			} finally {
				delete process.env[CONFIG_ROOT_VAR];
			}
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("rollback removes a file the migration created and restores replaced ones", () => {
		const f = fixture();
		try {
			write(path.join(f.target, "config.toml"), LEGACY_TOML);
			write(path.join(f.target, ".env"), "KEPT=before\n");
			write(path.join(f.source, ".env"), "KEPT=before\nNEW_KEY=from-source\n");
			applyMigration(
				planMigration({ source: f.source, target: f.target, home: f.home }),
			);
			// The merge added the missing key and left the existing one alone.
			expect(fs.readFileSync(path.join(f.target, ".env"), "utf8")).toBe(
				"KEPT=before\nNEW_KEY=from-source\n",
			);
			expect(fs.existsSync(path.join(f.target, "config.json"))).toBe(true);

			// Re-create a journal exactly as a stopped publication would leave it: the
			// replaced `.env` has its previous content backed up, the converted
			// `config.json` was newly created so it has no backup.
			const backupDir = path.join(f.target, ".config-backup", "rollback");
			const targetBackups = path.join(backupDir, "targets");
			fs.mkdirSync(targetBackups, { recursive: true });
			const envBackup = path.join(targetBackups, "0-.env");
			fs.writeFileSync(envBackup, "KEPT=before\n", { mode: 0o600 });
			fs.writeFileSync(
				migrationJournalPath(f.target),
				`${JSON.stringify({
					version: 1,
					state: "published",
					createdAt: new Date().toISOString(),
					targetRoot: f.target,
					backupDir,
					sources: [],
					targets: [
						{
							path: path.join(f.target, ".env"),
							backup: envBackup,
							sha256: sha256File(path.join(f.target, ".env")),
						},
						{
							path: path.join(f.target, "config.json"),
							sha256: sha256File(path.join(f.target, "config.json")),
						},
					],
					secretKeys: ["NEW_KEY"],
				})}\n`,
			);
			expect(rollbackMigration(f.target)).toBe(2);
			expect(fs.existsSync(migrationJournalPath(f.target))).toBe(false);
			// The replaced file is back to its backup; the created file is gone.
			expect(fs.readFileSync(path.join(f.target, ".env"), "utf8")).toBe(
				"KEPT=before\n",
			);
			expect(fs.existsSync(path.join(f.target, "config.json"))).toBe(false);
			// The legacy source is untouched by the whole cycle.
			expect(fs.readFileSync(path.join(f.target, "config.toml"), "utf8")).toBe(
				LEGACY_TOML,
			);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("rollback keeps a file that was edited after publication", () => {
		const f = fixture();
		try {
			const target = path.join(f.target, ".env");
			write(target, "EDITED=later\n");
			const backupDir = path.join(f.target, ".config-backup", "kept");
			fs.mkdirSync(backupDir, { recursive: true });
			const backup = path.join(backupDir, "1-.env");
			write(backup, "ORIGINAL=before\n", 0o600);
			fs.writeFileSync(
				migrationJournalPath(f.target),
				`${JSON.stringify({
					version: 1,
					state: "published",
					createdAt: new Date().toISOString(),
					targetRoot: f.target,
					backupDir,
					sources: [],
					targets: [
						{
							path: target,
							backup,
							sha256: "0".repeat(64),
						},
					],
					secretKeys: [],
				})}\n`,
			);
			expect(rollbackMigration(f.target)).toBe(0);
			// A later edit is never silently discarded.
			expect(fs.readFileSync(target, "utf8")).toBe("EDITED=later\n");
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("credential extraction", () => {
	test("a clear-text provider credential moves into .env behind a reference", () => {
		const f = fixture();
		try {
			write(
				path.join(f.source, "providers", "github.json"),
				`${JSON.stringify(
					{
						name: "github-friendsfriend",
						type: "github",
						username: "octocat",
						token: "ghp_super_secret_value",
					},
					null,
					2,
				)}\n`,
				0o600,
			);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts).toEqual([]);
			expect(plan.actions.map((action) => action.kind)).toContain(
				"extract-credentials",
			);
			// The report names the variables, never the values.
			expect(plan.secretKeyNames).toEqual([
				"DEVENV_PROVIDER_GITHUB_FRIENDSFRIEND_TOKEN",
				"DEVENV_PROVIDER_GITHUB_FRIENDSFRIEND_USERNAME",
			]);
			expect(formatMigrationPlan(plan)).not.toContain("ghp_super_secret_value");

			applyMigration(plan);
			const providerJson = fs.readFileSync(
				path.join(f.target, "providers", "github.json"),
				"utf8",
			);
			expect(providerJson).not.toContain("ghp_super_secret_value");
			expect(providerJson).toContain(
				"${DEVENV_PROVIDER_GITHUB_FRIENDSFRIEND_TOKEN}",
			);
			expect(providerJson).toContain(
				"${DEVENV_PROVIDER_GITHUB_FRIENDSFRIEND_USERNAME}",
			);
			const envFile = path.join(f.target, ".env");
			expect(
				loadEnvFile(envFile).get("DEVENV_PROVIDER_GITHUB_FRIENDSFRIEND_TOKEN"),
			).toBe("ghp_super_secret_value");
			expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
			expect(
				fs.statSync(path.join(f.target, "providers", "github.json")).mode &
					0o777,
			).toBe(0o600);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("an existing reference is left exactly as it is", () => {
		const f = fixture();
		try {
			const original = `${JSON.stringify(
				{
					name: "github",
					type: "github",
					username: "${GITHUB_USER}",
					token: "${GITHUB_TOKEN}",
				},
				null,
				2,
			)}\n`;
			write(path.join(f.source, "providers", "github.json"), original, 0o600);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(
				plan.actions.some((action) => action.kind === "extract-credentials"),
			).toBe(false);
			applyMigration(plan);
			expect(
				fs.readFileSync(
					path.join(f.target, "providers", "github.json"),
					"utf8",
				),
			).toBe(original);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a colliding value in the root .env is a conflict, never overwritten", () => {
		const f = fixture();
		try {
			write(
				path.join(f.source, "providers", "github.json"),
				`${JSON.stringify({ name: "github", type: "github", token: "from-json" })}\n`,
				0o600,
			);
			write(
				path.join(f.target, ".env"),
				"DEVENV_PROVIDER_GITHUB_TOKEN=from-env\n",
			);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts.map((conflict) => conflict.kind)).toContain(
				"env-value",
			);
			const rendered = formatMigrationPlan(plan);
			expect(rendered).not.toContain("from-json");
			expect(rendered).not.toContain("from-env");
			expect(() => applyMigration(plan)).toThrow(/conflict/);
			expect(fs.readFileSync(path.join(f.target, ".env"), "utf8")).toContain(
				"from-env",
			);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a credential-looking unknown field needs review, without printing it", () => {
		const f = fixture();
		try {
			write(
				path.join(f.source, "providers", "github.json"),
				`${JSON.stringify({
					name: "github",
					type: "github",
					username: "${GITHUB_USER}",
					token: "${GITHUB_TOKEN}",
					password: "hunter2",
				})}\n`,
				0o600,
			);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts.map((conflict) => conflict.kind)).toEqual([
				"suspicious-field",
			]);
			const rendered = formatMigrationPlan(plan);
			expect(rendered).toContain("password");
			expect(rendered).not.toContain("hunter2");
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("two providers sharing one credential slot are a conflict", () => {
		const f = fixture();
		try {
			write(
				path.join(f.source, "providers", "a.json"),
				`${JSON.stringify({ name: "github-org", type: "github", token: "one" })}\n`,
				0o600,
			);
			write(
				path.join(f.source, "providers", "b.json"),
				`${JSON.stringify({ name: "github.org", type: "github", token: "two" })}\n`,
				0o600,
			);
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(plan.conflicts.map((conflict) => conflict.kind)).toContain(
				"duplicate-ident",
			);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("legacy root discovery", () => {
	test("honors the deprecated variable, then the documented default", () => {
		expect(legacyEnvRoot({ DEVENV_CONFIG_DIR: "/tmp/legacy" }, "/home/u")).toBe(
			"/tmp/legacy",
		);
		expect(legacyEnvRoot({}, "/home/u")).toBe("/home/u/.config/devenv");
	});
});
