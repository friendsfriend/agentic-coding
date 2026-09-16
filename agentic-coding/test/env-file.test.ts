// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
// The one `.env` contract and provider reference resolution
// (unify-json-configuration-directory, tasks 3.1-3.3). Every case runs in a
// temporary directory with an injected environment; no test reads real user
// configuration or real secrets.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	envReferenceName,
	expandEnvHome,
	isEnvReference,
	loadEnvFile,
	removeEnvFileKeys,
	resolveEnvReference,
	upsertEnvFile,
} from "../src/env-file.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import {
	executionSettings,
	settingsFingerprint,
} from "../src/workflow/effects.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "env-file-"));
}

describe(".env parsing", () => {
	test("supports the documented legacy syntax and nothing more", () => {
		const dir = tempDir();
		try {
			const file = path.join(dir, ".env");
			fs.writeFileSync(
				file,
				[
					"# a comment",
					"",
					"PLAIN=value",
					"export EXPORTED=exported-value",
					"SINGLE='single value'",
					'DOUBLE="double value"',
					"ESCAPED='it\\'s here'",
					"BACKSLASH='c:\\\\path'",
					"NEWLINE='line1\\nline2'",
					"TAB='a\\tb'",
					"EMPTY=",
					"COMPUTED=$(rm -rf /)",
					"SPACED = padded ",
					"NO_EQUALS_LINE",
				].join("\n"),
			);
			const vars = loadEnvFile(file);
			expect(vars.get("PLAIN")).toBe("value");
			expect(vars.get("EXPORTED")).toBe("exported-value");
			expect(vars.get("SINGLE")).toBe("single value");
			expect(vars.get("DOUBLE")).toBe("double value");
			expect(vars.get("ESCAPED")).toBe("it's here");
			expect(vars.get("BACKSLASH")).toBe("c:\\path");
			expect(vars.get("NEWLINE")).toBe("line1\nline2");
			expect(vars.get("TAB")).toBe("a\tb");
			expect(vars.get("EMPTY")).toBe("");
			// No shell evaluation: a substitution stays literal text.
			expect(vars.get("COMPUTED")).toBe("$(rm -rf /)");
			expect(vars.get("SPACED")).toBe("padded");
			expect(vars.has("NO_EQUALS_LINE")).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing file is empty, and the current directory is never scanned", () => {
		const dir = tempDir();
		const previousCwd = process.cwd();
		try {
			fs.writeFileSync(path.join(dir, ".env"), "IMPLICIT=loaded\n");
			process.chdir(dir);
			expect(loadEnvFile(path.join(dir, "absent.env")).size).toBe(0);
			expect(loadEnvFile(path.join(dir, "absent.env")).has("IMPLICIT")).toBe(
				false,
			);
		} finally {
			process.chdir(previousCwd);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("$HOME expansion is bootstrap-only and opt-in", () => {
		expect(expandEnvHome("~/devenv", "/home/u")).toBe("~/devenv");
		expect(expandEnvHome("$HOME/devenv", "/home/u")).toBe("/home/u/devenv");
		expect(expandEnvHome("${HOME}/devenv", "/home/u")).toBe("/home/u/devenv");
		// Parsing itself never expands: a credential is a credential.
		const dir = tempDir();
		try {
			const file = path.join(dir, ".env");
			fs.writeFileSync(file, "TOKEN=$HOME$HOME\n");
			expect(loadEnvFile(file).get("TOKEN")).toBe("$HOME$HOME");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe(".env writes", () => {
	test("preserves unrelated lines, is atomic and stays owner-only", () => {
		const dir = tempDir();
		try {
			const file = path.join(dir, ".env");
			fs.writeFileSync(
				file,
				"# keep this comment\nKEEP=unchanged\nexport OLD=old-value\n",
			);
			upsertEnvFile(file, new Map([["NEW", "new-value"]]));
			const text = fs.readFileSync(file, "utf8");
			expect(text).toContain("# keep this comment");
			expect(text).toContain("KEEP=unchanged");
			expect(text).toContain("export OLD=old-value");
			expect(text).toContain("NEW=new-value");
			expect(loadEnvFile(file).get("OLD")).toBe("old-value");
			// No temporary file survives, and the mode is owner-only.
			expect(fs.readdirSync(dir)).toEqual([".env"]);
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);

			removeEnvFileKeys(file, ["OLD"]);
			expect(loadEnvFile(file).has("OLD")).toBe(false);
			expect(fs.readFileSync(file, "utf8")).toContain("KEEP=unchanged");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a value with quotes, backslashes and newlines round-trips exactly", () => {
		const dir = tempDir();
		try {
			const file = path.join(dir, ".env");
			const tricky = "a\"b'c\\d$e\nf\tg #h";
			upsertEnvFile(file, new Map([["TRICKY", tricky]]));
			expect(loadEnvFile(file).get("TRICKY")).toBe(tricky);
			// The file is written atomically and remains owner-only.
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);

			// A second write appends rather than rewriting the first value.
			upsertEnvFile(file, new Map([["SECOND", "two"]]));
			expect(loadEnvFile(file).get("TRICKY")).toBe(tricky);
			expect(loadEnvFile(file).get("SECOND")).toBe("two");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("reference resolution", () => {
	const fileVars = new Map([
		["FROM_FILE", "file-value"],
		["EMPTY_IN_FILE", ""],
	]);

	test("whole-value references only", () => {
		expect(isEnvReference("${NAME}")).toBe(true);
		expect(envReferenceName("${NAME}")).toBe("NAME");
		expect(isEnvReference("prefix-${NAME}")).toBe(false);
		expect(isEnvReference("${}")).toBe(false);
		expect(isEnvReference("plain")).toBe(false);
	});

	test("an explicit process value wins, including an explicit empty one", () => {
		expect(
			resolveEnvReference("FROM_FILE", {
				fileVars,
				env: { FROM_FILE: "process-value" },
			}),
		).toBe("process-value");
		expect(
			resolveEnvReference("FROM_FILE", { fileVars, env: { FROM_FILE: "" } }),
		).toBe("");
		expect(
			resolveEnvReference("FROM_FILE", { fileVars, env: { OTHER: "x" } }),
		).toBe("file-value");
		expect(resolveEnvReference("EMPTY_IN_FILE", { fileVars, env: {} })).toBe(
			"",
		);
		// An unknown name is reported as undefined, never invented.
		expect(
			resolveEnvReference("ABSENT", { fileVars, env: {} }),
		).toBeUndefined();
	});
});

describe("provider credentials", () => {
	function store(): { store: ProviderStore; dir: string; envFile: string } {
		const dir = tempDir();
		const envFile = path.join(dir, ".env");
		return {
			store: new ProviderStore(path.join(dir, "providers"), envFile),
			dir,
			envFile,
		};
	}

	function writeProvider(
		dir: string,
		name: string,
		payload: Record<string, unknown>,
	): void {
		fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "providers", `${name}.json`),
			`${JSON.stringify(payload, null, 2)}\n`,
		);
	}

	test("a secret with JSON delimiters resolves without corrupting the file", () => {
		const { store: providers, dir, envFile } = store();
		const previous = process.env.SECRET_JSON_DELIMS;
		try {
			const secret = 'tok"en\\with\nnewline\tand $dollar';
			fs.writeFileSync(
				envFile,
				`SECRET_JSON_DELIMS=${JSON.stringify(secret)}\n`,
			);
			writeProvider(dir, "github", {
				name: "github",
				type: "github",
				username: "${GITHUB_USER}",
				token: "${SECRET_JSON_DELIMS}",
			});
			delete process.env.SECRET_JSON_DELIMS;
			providers.load();
			expect(providers.get("github")?.token).toBe(secret);
			expect(providers.get("github")?.missingVars).toEqual(["GITHUB_USER"]);
			// The provider file itself is untouched and still valid JSON.
			const raw = fs.readFileSync(
				path.join(dir, "providers", "github.json"),
				"utf8",
			);
			expect(JSON.parse(raw).token).toBe("${SECRET_JSON_DELIMS}");
		} finally {
			if (previous === undefined) delete process.env.SECRET_JSON_DELIMS;
			else process.env.SECRET_JSON_DELIMS = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an explicit process value overrides the root .env", () => {
		const { store: providers, dir, envFile } = store();
		const previous = process.env.OVERRIDDEN_TOKEN;
		try {
			fs.writeFileSync(envFile, "OVERRIDDEN_TOKEN=from-file\n");
			writeProvider(dir, "github", {
				name: "github",
				type: "github",
				username: "",
				token: "${OVERRIDDEN_TOKEN}",
			});
			process.env.OVERRIDDEN_TOKEN = "from-process";
			providers.load();
			expect(providers.get("github")?.token).toBe("from-process");
			// An explicit empty value is a value, not a miss.
			process.env.OVERRIDDEN_TOKEN = "";
			providers.load();
			expect(providers.get("github")?.token).toBe("");
			expect(providers.get("github")?.missingVars).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.OVERRIDDEN_TOKEN;
			else process.env.OVERRIDDEN_TOKEN = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing reference is reported by name and yields no value", () => {
		const { store: providers, dir } = store();
		try {
			writeProvider(dir, "github", {
				name: "github",
				type: "github",
				username: "${ABSENT_USER}",
				token: "${ABSENT_TOKEN}",
			});
			providers.load();
			const provider = providers.get("github");
			expect(provider?.missingVars.sort()).toEqual([
				"ABSENT_TOKEN",
				"ABSENT_USER",
			]);
			expect(provider?.username).toBe("");
			expect(provider?.token).toBe("");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an inline or literal credential is still refused", () => {
		const { store: providers, dir } = store();
		try {
			writeProvider(dir, "inline", {
				name: "inline",
				type: "github",
				username: "bot",
				token: "ghp_super_secret_value",
			});
			writeProvider(dir, "embedded", {
				name: "embedded",
				type: "github",
				username: "bot-${GITHUB_USER}",
				token: "${GITHUB_TOKEN}",
			});
			writeProvider(dir, "typed", {
				name: "typed",
				type: "github",
				username: "bot",
				token: 12345,
			});
			providers.load();
			expect(providers.get("inline")).toBeUndefined();
			expect(providers.get("embedded")).toBeUndefined();
			expect(
				providers
					.invalidProviders()
					.map((entry) => entry.name)
					.sort(),
			).toEqual(["embedded", "inline", "typed"]);
			// No invalid reason ever carries the credential value.
			expect(JSON.stringify(providers.invalidProviders())).not.toContain(
				"ghp_super_secret_value",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("saving writes .env owner-only and keeps a reference in the file", () => {
		const { store: providers, dir, envFile } = store();
		try {
			providers.load();
			providers.save({
				name: "github",
				type: "github",
				username: "bot",
				token: "ghp_super_secret_value",
				missingVars: [],
			});
			const raw = fs.readFileSync(
				path.join(dir, "providers", "github.json"),
				"utf8",
			);
			expect(raw).toContain("${DEVENV_PROVIDER_GITHUB_USERNAME}");
			expect(raw).toContain("${DEVENV_PROVIDER_GITHUB_TOKEN}");
			// The literal is nowhere in the JSON, and .env is owner-only.
			expect(raw).not.toContain("ghp_super_secret_value");
			expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
			expect(loadEnvFile(envFile).get("DEVENV_PROVIDER_GITHUB_TOKEN")).toBe(
				"ghp_super_secret_value",
			);

			// A username-only edit keeps the stored token reference and does not
			// materialize a value resolved from the process environment.
			const previous = process.env.DEVENV_PROVIDER_GITHUB_TOKEN;
			process.env.DEVENV_PROVIDER_GITHUB_TOKEN = "from-process";
			try {
				providers.load();
				providers.save({
					name: "github",
					type: "github",
					username: "other-bot",
					token: "",
					missingVars: [],
				});
				expect(loadEnvFile(envFile).get("DEVENV_PROVIDER_GITHUB_TOKEN")).toBe(
					"ghp_super_secret_value",
				);
				expect(
					fs.readFileSync(path.join(dir, "providers", "github.json"), "utf8"),
				).toContain("${DEVENV_PROVIDER_GITHUB_TOKEN}");
			} finally {
				if (previous === undefined)
					delete process.env.DEVENV_PROVIDER_GITHUB_TOKEN;
				else process.env.DEVENV_PROVIDER_GITHUB_TOKEN = previous;
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("a saved credential with delimiters round-trips through .env and the JSON", () => {
		const { store: providers, dir, envFile } = store();
		try {
			providers.load();
			const token = 'ghp_"quoted\\slashed\nnewline\ttab $dollar';
			providers.save({
				name: "github",
				type: "github",
				username: "bot",
				token,
				missingVars: [],
			});
			// The JSON keeps a reference and no part of the value.
			const raw = fs.readFileSync(
				path.join(dir, "providers", "github.json"),
				"utf8",
			);
			expect(raw).toContain("${DEVENV_PROVIDER_GITHUB_TOKEN}");
			expect(raw).not.toContain("quoted");
			expect(raw).not.toContain("newline");
			// A fresh read returns the exact string that was stored.
			providers.load();
			expect(providers.get("github")?.token).toBe(token);
			expect(loadEnvFile(envFile).get("DEVENV_PROVIDER_GITHUB_TOKEN")).toBe(
				token,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unknown reference in the JSON is reported, never expanded or dropped", () => {
		const { store: providers, dir } = store();
		try {
			writeProvider(dir, "github", {
				name: "github",
				type: "github",
				username: "${GITHUB_USER}",
				token: "${DEVENV_PROVIDER_GITHUB_TOKEN}",
			});
			providers.load();
			// Username is resolved before token, so that is the reported order.
			expect(providers.get("github")?.missingVars).toEqual([
				"GITHUB_USER",
				"DEVENV_PROVIDER_GITHUB_TOKEN",
			]);
			expect(providers.get("github")?.token).toBe("");
			// The reference survives in the file so it resolves once the value exists.
			expect(
				fs.readFileSync(path.join(dir, "providers", "github.json"), "utf8"),
			).toContain("${DEVENV_PROVIDER_GITHUB_TOKEN}");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("secret confinement", () => {
	test("a resolved credential never enters execution settings or a workflow pin", () => {
		const previous = process.env.PINNED_TOKEN;
		try {
			process.env.PINNED_TOKEN = "super-secret-value";
			// `executionSettings` is what a workflow pins: remote, PR tool and
			// provenance. No credential reference is present, and nothing resolved
			// may reach it.
			const settings = executionSettings(
				{
					workflow: {
						max_verification_rounds: 6,
						remote: "origin",
						branch_prefix: "feature/",
						base_branch: "origin/HEAD",
					},
					telemetry: { capture_content: false },
					ui: { theme: "catppuccin", selection_height: 10 },
				},
				{ source: "user", files: ["/tmp/config.json"] },
			);
			const serialized = JSON.stringify(settings);
			expect(serialized).not.toContain("super-secret-value");
			expect(serialized).not.toContain("PINNED_TOKEN");
			// The pinned settings fingerprint is stable and value-free.
			expect(settingsFingerprint(settings)).not.toContain("super-secret-value");
			expect(settingsFingerprint(settings)).toBe(settingsFingerprint(settings));
		} finally {
			if (previous === undefined) delete process.env.PINNED_TOKEN;
			else process.env.PINNED_TOKEN = previous;
		}
	});
});
