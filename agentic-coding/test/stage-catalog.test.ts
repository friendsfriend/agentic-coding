// The stage catalog (`add-stage-testing-foundation`, task 1.4).
//
// The catalog is the allow-list: only a stage file of the canonical
// configuration root that passes every structural check may be driven, and a
// refused stage is reported with value-free diagnostics. Every test builds its
// own throwaway configuration root, so no test reads (or writes) a real stage,
// a real `.env` or the developer's own configuration.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	credentialVariable,
	DEFAULT_STAGE_LIMITS,
	readStageCatalog,
	stageByIdent,
	stageCredentialVariables,
	stagePaths,
	stageRefusalReason,
	stageView,
} from "../src/server/stages/catalog.ts";

const PASSWORD_VARIABLE = "GRID_INT_CLERK_PASSWORD";
const READER_VARIABLE = "GRID_INT_READER_PASSWORD";
/** A sentinel that must never appear in a diagnostic: it stands in for a
 * credential a stage file wrongly inlined instead of referencing. */
const LITERAL_SECRET = "sentinel-literal-credential-9f2c";

function configRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stage-catalog-"));
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeStage(
	configDir: string,
	ident: string,
	definition: unknown,
): void {
	writeJson(
		path.join(stagePaths(configDir).defsDir, `${ident}.json`),
		definition,
	);
}

function writePolicy(configDir: string, policy: unknown): void {
	writeJson(stagePaths(configDir).policyFile, policy);
}

function writeEnv(configDir: string, entries: Record<string, string>): void {
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`${Object.entries(entries)
			.map(([name, value]) => `${name}=${value}`)
			.join("\n")}\n`,
	);
}

function writeApp(configDir: string, ident: string): void {
	writeJson(path.join(configDir, "apps", "definitions", `${ident}.json`), {
		ident,
		displayName: ident,
		appType: "APP",
	});
}

/** One valid stage: https, an integration (never production-like) environment,
 * one application with two roles. */
function stageFile(overrides: Record<string, unknown> = {}): unknown {
	return {
		ident: "grid-int",
		displayName: "Grid integration",
		environment: "integration",
		system: "grid",
		access: "read-only",
		apps: {
			web: {
				label: "Grid web",
				url: "https://grid-int.example.test/",
				kind: "ui",
				roles: {
					clerk: {
						login: "web-form",
						username: "${GRID_INT_CLERK_USERNAME}",
						password: `\${${PASSWORD_VARIABLE}}`,
					},
					reader: { password: `\${${READER_VARIABLE}}` },
				},
			},
		},
		logins: {
			"web-form": {
				kind: "form",
				steps: [
					{
						fields: [{ credential: "username", label: "User" }],
						submit: { role: "button", name: "Next" },
					},
					{ fields: [{ credential: "password", label: "Password" }] },
				],
			},
		},
		allowedOrigins: ["https://login.example.test"],
		...overrides,
	};
}

describe("stage catalog", () => {
	test("a valid stage is allow-listed with its origins, defaults and credential status", () => {
		const configDir = configRoot();
		writeStage(configDir, "grid-int", stageFile());
		writeEnv(configDir, {
			[PASSWORD_VARIABLE]: "clerk-secret-sentinel",
			GRID_INT_CLERK_USERNAME: "clerk@example.test",
		});
		const catalog = readStageCatalog(configDir);
		expect(catalog.excluded).toEqual([]);
		const entry = stageByIdent(catalog, "grid-int");
		expect(entry).toBeDefined();
		if (!entry) throw new Error("unreachable");
		// The allow-list is the applications' origins plus the declared ones.
		expect(entry.origins).toEqual([
			"https://grid-int.example.test",
			"https://login.example.test",
		]);
		expect(entry.limits).toEqual(DEFAULT_STAGE_LIMITS);
		const view = stageView(entry, configDir);
		expect(view.access).toBe("read-only");
		expect(view.apps[0]?.roles).toEqual([
			{
				role: "clerk",
				login: "web-form",
				loginKind: "form",
				credentials: [
					{
						field: "username",
						variable: "GRID_INT_CLERK_USERNAME",
						status: "set",
					},
					{
						field: "password",
						variable: PASSWORD_VARIABLE,
						status: "set",
					},
				],
			},
			{
				role: "reader",
				credentials: [
					// No value, not even a masked one: a status names the variable — and a
					// `set` status names it too, because that is the key a *replacement*
					// would be written to.
					{
						field: "password",
						variable: READER_VARIABLE,
						status: `missing ${READER_VARIABLE}`,
					},
				],
			},
		]);
		// The catalog knows exactly which keys a credential flow may write.
		const variables = stageCredentialVariables(catalog);
		expect([...variables.keys()].sort()).toEqual([
			"GRID_INT_CLERK_PASSWORD",
			"GRID_INT_CLERK_USERNAME",
			"GRID_INT_READER_PASSWORD",
		]);
		expect(variables.get(PASSWORD_VARIABLE)).toEqual({
			stage: "grid-int",
			app: "Grid web",
			role: "clerk",
			field: "password",
		});
		expect(credentialVariable(entry.stage, "web", "clerk", "password")).toBe(
			PASSWORD_VARIABLE,
		);
	});

	test("only the canonical configuration root is read", () => {
		const configDir = configRoot();
		const repository = path.join(configDir, "repo");
		// A stage tree beside a repository, and a repository overlay: neither is a
		// configuration root, so neither can add or shadow a stage.
		writeStage(repository, "grid-int", stageFile());
		writeJson(path.join(repository, ".pi", "herdr-workflow.json"), {
			stages: { definitions: { "grid-int": stageFile() } },
		});
		const catalog = readStageCatalog(configDir);
		expect(catalog.entries).toEqual([]);
		expect(catalog.excluded).toEqual([]);
		expect(stagePaths(configDir).defsDir).toBe(
			path.join(configDir, "stages", "definitions"),
		);
	});

	test("an ident that is not the file stem is refused", () => {
		const configDir = configRoot();
		writeStage(configDir, "grid-int", stageFile({ ident: "grid-other" }));
		const catalog = readStageCatalog(configDir);
		expect(catalog.entries).toEqual([]);
		expect(catalog.excluded).toHaveLength(1);
		expect(catalog.excluded[0]?.file).toBe("grid-int.json");
		expect(catalog.excluded[0]?.diagnostics[0]?.message).toContain(
			"must equal the file stem",
		);
		expect(stageRefusalReason(catalog, "grid-int")).toContain(
			"is not allow-listed",
		);
	});

	test("a production-like stage can never be configured", () => {
		const configDir = configRoot();
		writeStage(configDir, "grid-int", stageFile({ environment: "production" }));
		writeStage(
			configDir,
			"grid-stage",
			stageFile({ ident: "grid-stage", environment: "integration" }),
		);
		const catalog = readStageCatalog(configDir);
		expect(catalog.entries.map((entry) => entry.ident)).toEqual(["grid-stage"]);
		const refused = catalog.excluded[0];
		expect(refused?.ident).toBe("grid-int");
		expect(refused?.diagnostics[0]?.field).toBe("environment");
		expect(refused?.diagnostics[0]?.message).toContain("production-like");
	});

	test("a denied host and a plaintext host are refused, insecureHttp allows the second", () => {
		const configDir = configRoot();
		writePolicy(configDir, { deniedHostPatterns: ["*.prod.example.test"] });
		writeStage(
			configDir,
			"grid-denied",
			stageFile({
				ident: "grid-denied",
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid.prod.example.test/",
						kind: "ui",
					},
				},
			}),
		);
		writeStage(
			configDir,
			"grid-http",
			stageFile({
				ident: "grid-http",
				apps: {
					web: {
						label: "Grid web",
						url: "http://grid-int.example.test/",
						kind: "ui",
					},
				},
			}),
		);
		const refused = readStageCatalog(configDir);
		expect(refused.entries).toEqual([]);
		expect(
			refused.excluded.find((entry) => entry.ident === "grid-denied")
				?.diagnostics[0]?.message,
		).toContain("denied pattern");
		expect(
			refused.excluded.find((entry) => entry.ident === "grid-http")
				?.diagnostics[0]?.message,
		).toContain("must use https");

		// The whole catalog is read again, with the plaintext stage opting in; a
		// loopback host needs no opt-in at all.
		writeStage(
			configDir,
			"grid-http",
			stageFile({
				ident: "grid-http",
				insecureHttp: true,
				apps: {
					web: {
						label: "Grid web",
						url: "http://grid-int.example.test/",
						kind: "ui",
					},
				},
			}),
		);
		const allowed = readStageCatalog(configDir);
		expect(allowed.entries.map((entry) => entry.ident)).toEqual(["grid-http"]);
		expect(allowed.entries[0]?.origins).toEqual([
			"http://grid-int.example.test",
			"https://login.example.test",
		]);
	});

	test("a literal credential is refused and its value never reaches a diagnostic", () => {
		const configDir = configRoot();
		writeStage(
			configDir,
			"grid-int",
			stageFile({
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid-int.example.test/",
						kind: "ui",
						roles: { clerk: { password: LITERAL_SECRET } },
					},
				},
				logins: {},
			}),
		);
		const catalog = readStageCatalog(configDir);
		expect(catalog.entries).toEqual([]);
		const diagnostics = catalog.excluded[0]?.diagnostics ?? [];
		expect(diagnostics[0]?.field).toBe("apps.web.roles.clerk.password");
		expect(diagnostics[0]?.message).toContain("${VARIABLE}");
		// The whole catalog is searched, not just the printed message: a value in
		// an issue path, a file name or a second diagnostic would be the same leak.
		expect(JSON.stringify(catalog)).not.toContain(LITERAL_SECRET);
	});

	test("an app ident that is not configured is refused", () => {
		const configDir = configRoot();
		writeApp(configDir, "grid-web");
		writeStage(
			configDir,
			"grid-int",
			stageFile({
				apps: {
					web: {
						label: "Grid web",
						app: "grid-typo",
						url: "https://grid-int.example.test/",
						kind: "ui",
					},
				},
			}),
		);
		const catalog = readStageCatalog(configDir);
		expect(catalog.entries).toEqual([]);
		expect(catalog.excluded[0]?.diagnostics[0]?.field).toBe("apps.web.app");
		expect(catalog.excluded[0]?.diagnostics[0]?.message).toContain(
			"apps/definitions",
		);

		// The same stage with the configured ident is allow-listed.
		writeStage(
			configDir,
			"grid-int",
			stageFile({
				apps: {
					web: {
						label: "Grid web",
						app: "grid-web",
						url: "https://grid-int.example.test/",
						kind: "ui",
					},
				},
			}),
		);
		const allowed = readStageCatalog(configDir);
		expect(allowed.entries.map((entry) => entry.ident)).toEqual(["grid-int"]);
	});

	test("an unusable policy refuses every stage and says why", () => {
		const configDir = configRoot();
		writePolicy(configDir, { deniedHostPatterns: "not-a-list" });
		writeStage(configDir, "grid-int", stageFile());
		const catalog = readStageCatalog(configDir);
		expect(catalog.entries).toEqual([]);
		expect(catalog.excluded.map((entry) => entry.file)).toEqual([
			"grid-int.json",
		]);
		// The refusal carries the policy's own reason. The policy is recorded — and
		// compared — under its basename, so a stage that vanished always says why.
		const diagnostics = catalog.excluded[0]?.diagnostics ?? [];
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics.every((entry) => entry.file === "policy.json")).toBe(
			true,
		);
		expect(
			diagnostics.some((entry) => entry.field.includes("deniedHostPatterns")),
		).toBe(true);
		// The refusal reads as the stage's own, with the policy's complaint as its
		// reason: a developer sees the file that vanished and the field that made it
		// vanish (the policy, named by basename in the diagnostic above).
		expect(stageRefusalReason(catalog, "grid-int")).toContain(
			"$.deniedHostPatterns",
		);
	});

	test("a policy file that is not JSON refuses every stage, and a policy that cannot be read says so", () => {
		// A policy that exists but cannot be trusted must not be guessed at: an
		// unknown deny list would allow a stage an operator meant to deny.
		const broken = configRoot();
		fs.mkdirSync(path.dirname(stagePaths(broken).policyFile), {
			recursive: true,
		});
		fs.writeFileSync(stagePaths(broken).policyFile, "{ not json");
		writeStage(broken, "grid-int", stageFile());
		const notJson = readStageCatalog(broken);
		expect(notJson.entries).toEqual([]);
		expect(notJson.excluded.map((entry) => entry.file)).toEqual([
			"grid-int.json",
		]);
		const messages = (notJson.excluded[0]?.diagnostics ?? []).map(
			(diagnostic) =>
				`${diagnostic.file} ${diagnostic.field}: ${diagnostic.message}`,
		);
		expect(messages).toContain(
			"policy.json $: not valid JSON, so no stage is allow-listed",
		);

		// An unreadable policy is a different refusal, and it is not mistaken for an
		// absent one: a directory where the file belongs reads as present-but-broken.
		const unreadable = configRoot();
		fs.mkdirSync(stagePaths(unreadable).policyFile, { recursive: true });
		writeStage(unreadable, "grid-int", stageFile());
		const unreadableCatalog = readStageCatalog(unreadable);
		expect(unreadableCatalog.entries).toEqual([]);
		expect(
			(unreadableCatalog.excluded[0]?.diagnostics ?? []).map(
				(diagnostic) => `${diagnostic.file}: ${diagnostic.message}`,
			),
		).toContain("policy.json: the stage policy could not be read");
	});

	test("a stage file that is not JSON or cannot be read is excluded with a value-free reason", () => {
		const configDir = configRoot();
		const file = path.join(stagePaths(configDir).defsDir, "grid-int.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			`{"ident": "grid-int", "password": "${LITERAL_SECRET}"`,
		);
		const catalog = readStageCatalog(configDir);
		expect(catalog.entries).toEqual([]);
		expect(catalog.excluded.map((entry) => entry.file)).toEqual([
			"grid-int.json",
		]);
		expect(
			(catalog.excluded[0]?.diagnostics ?? []).map(
				(diagnostic) => diagnostic.message,
			),
		).toEqual(["not valid JSON"]);
		// Half a file can still contain half a credential, so the diagnostic names the
		// field and never the text it could not parse.
		expect(JSON.stringify(catalog)).not.toContain(LITERAL_SECRET);

		// A file the process may not read is skipped with its own reason rather than
		// crashing the catalog the whole dashboard depends on.
		const lockedDir = configRoot();
		const locked = path.join(stagePaths(lockedDir).defsDir, "grid-int.json");
		writeStage(lockedDir, "grid-int", stageFile());
		fs.chmodSync(locked, 0o000);
		const lockedCatalog = readStageCatalog(lockedDir);
		fs.chmodSync(locked, 0o600);
		if (process.getuid?.() !== 0) {
			expect(lockedCatalog.entries).toEqual([]);
			expect(catalog.excluded.length).toBe(1);
			expect(
				(lockedCatalog.excluded[0]?.diagnostics ?? []).map(
					(diagnostic) => diagnostic.message,
				),
			).toEqual(["the stage file could not be read"]);
		}
	});

	test("an empty configuration root allow-lists nothing", () => {
		// An empty root would resolve `stages/definitions` and `.env` against the
		// process's own working directory, so it fails closed instead of reading
		// whatever happens to be there.
		const catalog = readStageCatalog("");
		expect(catalog.entries).toEqual([]);
		expect(catalog.excluded).toEqual([]);
		expect(catalog.diagnostics[0]?.kind).toBe("error");
		expect(catalog.diagnostics[0]?.message).toContain("configuration root");
	});

	test("a declared bound above the policy ceiling is clamped and reported", () => {
		const configDir = configRoot();
		writePolicy(configDir, {
			ceilings: { maxSessions: 1, maxWaitSeconds: 30 },
		});
		writeStage(
			configDir,
			"grid-int",
			stageFile({ limits: { maxSessions: 5, maxWaitSeconds: 900 } }),
		);
		const catalog = readStageCatalog(configDir);
		const entry = catalog.entries[0];
		expect(entry?.limits.maxSessions).toBe(1);
		expect(entry?.limits.maxWaitSeconds).toBe(30);
		// The bounds the stage did not declare stay at their documented default.
		expect(entry?.limits.maxScreenshots).toBe(
			DEFAULT_STAGE_LIMITS.maxScreenshots,
		);
		const warnings = (entry?.diagnostics ?? []).map(
			(diagnostic) => `${diagnostic.field}: ${diagnostic.message}`,
		);
		expect(warnings).toContain(
			"limits.maxSessions: clamped to the policy ceiling 1",
		);
		expect(warnings).toContain(
			"limits.maxWaitSeconds: clamped to the policy ceiling 30",
		);
	});
});
