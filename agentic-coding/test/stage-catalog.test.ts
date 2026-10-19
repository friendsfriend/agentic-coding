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
	DEFAULT_IDENTITY_CACHE,
	DEFAULT_STAGE_LIMITS,
	effectiveIdentityCache,
	MIN_IDENTITY_CACHE_REFRESH_SECONDS,
	readStageCatalog,
	stageByIdent,
	stageCredentialVariables,
	stagePaths,
	stageRefusalReason,
	stageView,
} from "../src/server/stages/catalog.ts";
import type { StagePolicy } from "../src/server/stages/schema.ts";

const PASSWORD_VARIABLE = "GRID_INT_CLERK_PASSWORD";
const READER_VARIABLE = "GRID_INT_READER_PASSWORD";
/** A sentinel that must never appear in a diagnostic: it stands in for a
 * credential a stage file wrongly inlined instead of referencing. */
const LITERAL_SECRET = "sentinel-literal-credential-9f2c";

/** The one stage a fixture config declares, or a failure that says so. */
function onlyEntry(catalog: ReturnType<typeof readStageCatalog>) {
	const entry = catalog.entries[0];
	if (!entry) throw new Error("the stage was not allow-listed");
	return entry;
}

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
				credentialStatus: "set",
				loginMode: "automated",
				cacheable: true,
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
				credentialStatus: `missing ${READER_VARIABLE}`,
				loginMode: "automated",
				cacheable: true,
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
	test("a stage's interactiveLogin can narrow the policy and never widen it", () => {
		const configDir = configRoot();
		writeStage(configDir, "grid-int", stageFile());
		writePolicy(configDir, { interactiveLogin: "never" });
		const narrowed = readStageCatalog(configDir);
		expect(narrowed.entries[0]?.interactiveLogin).toBe("never");

		// The stage asks for a window while the policy denies one: the policy wins
		// and the ignored field is reported instead of silently honoured.
		const widening = configRoot();
		writeStage(widening, "grid-int", stageFile({ interactiveLogin: "local" }));
		writePolicy(widening, { interactiveLogin: "never" });
		const entry = readStageCatalog(widening).entries[0];
		expect(entry?.interactiveLogin).toBe("never");
		expect(
			entry?.diagnostics.map(
				(diagnostic) => `${diagnostic.field}: ${diagnostic.message}`,
			),
		).toContain(
			'interactiveLogin: is ignored: the policy denies interactive login (policy.json interactiveLogin: "never")',
		);

		// The default is local on both sides.
		const open = configRoot();
		writeStage(open, "grid-int", stageFile());
		expect(readStageCatalog(open).entries[0]?.interactiveLogin).toBe("local");
	});

	test("the login hand-off bound defaults to 900 s and is clamped by its ceiling", () => {
		const configDir = configRoot();
		writeStage(configDir, "grid-int", stageFile());
		const entry = readStageCatalog(configDir).entries[0];
		expect(entry?.limits.maxLoginHandoffSeconds).toBe(900);

		const declared = configRoot();
		writeStage(
			declared,
			"grid-int",
			stageFile({ limits: { maxLoginHandoffSeconds: 1_800 } }),
		);
		expect(
			readStageCatalog(declared).entries[0]?.limits.maxLoginHandoffSeconds,
		).toBe(1_800);

		const clamped = configRoot();
		writeStage(
			clamped,
			"grid-int",
			stageFile({ limits: { maxLoginHandoffSeconds: 3_600 } }),
		);
		writePolicy(clamped, { ceilings: { maxLoginHandoffSeconds: 1_200 } });
		const clampedEntry = readStageCatalog(clamped).entries[0];
		expect(clampedEntry?.limits.maxLoginHandoffSeconds).toBe(1_200);
		expect(
			clampedEntry?.diagnostics.map(
				(diagnostic) => `${diagnostic.field}: ${diagnostic.message}`,
			),
		).toContain(
			"limits.maxLoginHandoffSeconds: clamped to the policy ceiling 1200",
		);
	});

	test("a policy ceiling above the hard login hand-off ceiling is reported and cannot lift it", () => {
		const configDir = configRoot();
		writeStage(
			configDir,
			"grid-int",
			stageFile({ limits: { maxLoginHandoffSeconds: 3_600 } }),
		);
		writePolicy(configDir, { ceilings: { maxLoginHandoffSeconds: 7_200 } });
		const catalog = readStageCatalog(configDir);
		// The hard ceiling is the longest a hand-off may block a stage action, so a
		// policy that declares more is lowered rather than trusted, and the operator
		// is told which ceiling acted (MIG-006, OSV-104).
		expect(catalog.entries[0]?.limits.maxLoginHandoffSeconds).toBe(1_800);
		expect(
			catalog.diagnostics
				.filter((diagnostic) => diagnostic.kind === "warning")
				.map((diagnostic) => `${diagnostic.field}: ${diagnostic.message}`),
		).toEqual([
			"ceilings.maxLoginHandoffSeconds: is lowered to the 1800 s login hand-off ceiling, which is the longest one hand-off may block a stage action",
			"limits.maxLoginHandoffSeconds: clamped to the 1800 s login hand-off ceiling",
		]);
		// A stage that stays under the hard ceiling is untouched, and no policy
		// warning is invented for a policy that declares nothing.
		const plain = configRoot();
		writeStage(
			plain,
			"grid-int",
			stageFile({ limits: { maxLoginHandoffSeconds: 1_800 } }),
		);
		writePolicy(plain, { ceilings: {} });
		expect(readStageCatalog(plain).diagnostics).toEqual([]);
		expect(
			readStageCatalog(plain).entries[0]?.limits.maxLoginHandoffSeconds,
		).toBe(1_800);
	});

	test("an interactive recipe must declare how the login counts as complete, and no steps", () => {
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
						roles: { clerk: { login: "sso" } },
					},
				},
				logins: { sso: { kind: "interactive" } },
			}),
		);
		const missingSuccess = readStageCatalog(configDir);
		// The stage is refused, and the complaint names the field rather than a
		// generic failure.
		expect(missingSuccess.entries).toEqual([]);
		expect(
			missingSuccess.excluded[0]?.diagnostics.map(
				(diagnostic) => `${diagnostic.field}: ${diagnostic.message}`,
			),
		).toContain(
			"logins.sso.success: the interactive recipe logins.sso must declare how the login counts as complete",
		);

		const withSteps = configRoot();
		writeStage(
			withSteps,
			"grid-int",
			stageFile({
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid-int.example.test/",
						kind: "ui",
						roles: { clerk: { login: "sso" } },
					},
				},
				logins: {
					sso: {
						kind: "interactive",
						success: { url: "https://grid-int.example.test/home" },
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
				},
			}),
		);
		expect(readStageCatalog(withSteps).entries).toEqual([]);

		// A complete interactive declaration is accepted, with no credential
		// reference at all.
		const valid = configRoot();
		writeStage(
			valid,
			"grid-int",
			stageFile({
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid-int.example.test/",
						kind: "ui",
						roles: { clerk: { login: "sso" } },
					},
				},
				logins: {
					sso: {
						kind: "interactive",
						success: { url: "https://grid-int.example.test/home" },
					},
				},
			}),
		);
		const entry = readStageCatalog(valid).entries[0];
		expect(entry?.ident).toBe("grid-int");
		if (!entry) throw new Error("the stage was not allow-listed");
		const role = stageView(entry, valid).apps[0]?.roles[0];
		expect(role?.loginKind).toBe("interactive");
		expect(role?.credentialStatus).toBe("none");
		expect(role?.credentials).toEqual([]);
		expect(role?.loginMode).toBe("handoff");
	});

	test("every role reports the login mode the policy and its own declaration allow", () => {
		const roles = {
			automated: {
				login: "web-form",
				password: `\${${PASSWORD_VARIABLE}}`,
			},
			missing: { login: "web-form", password: `\${${READER_VARIABLE}}` },
			norefs: { login: "web-form" },
			interactive: { login: "sso" },
			basic: { login: "https-basic" },
			none: {},
		};
		const definition = (interactiveLogin?: "local" | "never") =>
			stageFile({
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid-int.example.test/",
						kind: "ui",
						roles,
					},
				},
				logins: {
					"web-form": {
						kind: "form",
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					sso: {
						kind: "interactive",
						success: { url: "https://grid-int.example.test/home" },
					},
					"https-basic": { kind: "http-basic" },
				},
				...(interactiveLogin ? { interactiveLogin } : {}),
			});
		const modesFor = (interactiveLogin?: "local" | "never") => {
			const configDir = configRoot();
			writeStage(configDir, "grid-int", definition(interactiveLogin));
			writeEnv(configDir, { [PASSWORD_VARIABLE]: "clerk-secret-sentinel" });
			const view = stageView(onlyEntry(readStageCatalog(configDir)), configDir);
			return Object.fromEntries(
				(view.apps[0]?.roles ?? []).map((role) => [role.role, role.loginMode]),
			);
		};
		// The view the plan and the Settings section read names variables, never
		// values.
		expect(JSON.stringify(modesFor())).not.toContain("clerk-secret-sentinel");
		// Under the default policy a login needing a person is a hand-off.
		expect(modesFor()).toEqual({
			automated: "automated",
			missing: "handoff",
			norefs: "handoff",
			interactive: "handoff",
			// A `http-basic` role never hands off: the browser's own dialog does not
			// appear in a window this server launched, so the role stays unavailable.
			basic: "unavailable",
			none: "automated",
		});
		// Under `never` the same roles are unavailable, not silently automated.
		expect(modesFor("never")).toEqual({
			automated: "automated",
			missing: "unavailable",
			norefs: "unavailable",
			interactive: "unavailable",
			basic: "unavailable",
			none: "automated",
		});
		// And a stage that narrows to `never` says so in its own view.
		const narrowed = configRoot();
		writeStage(narrowed, "grid-int", definition("never"));
		writeEnv(narrowed, { [PASSWORD_VARIABLE]: "clerk-secret-sentinel" });
		const narrowedView = stageView(
			onlyEntry(readStageCatalog(narrowed)),
			narrowed,
		);
		expect(
			narrowedView.apps[0]?.roles.find((role) => role.role === "interactive")
				?.loginMode,
		).toBe("unavailable");
	});

	test("a role reports whether its login can be cached, and an opted-out stage caches none", () => {
		// `add-stage-identity-cache`: the identity cache can hold what this server
		// captured. An `http-basic` login is performed by the browser's own dialog,
		// whose `Authorization` header no driver here can observe, so that role is
		// non-cacheable and a surface can say so before the next login.
		const cacheableFor = (identityCache?: boolean) => {
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
							roles: {
								automated: {
									login: "web-form",
									password: `\${${PASSWORD_VARIABLE}}`,
								},
								interactive: { login: "sso" },
								basic: { login: "https-basic" },
								none: {},
							},
						},
					},
					logins: {
						"web-form": {
							kind: "form",
							steps: [
								{ fields: [{ credential: "password", label: "Password" }] },
							],
						},
						sso: {
							kind: "interactive",
							success: { url: "https://grid-int.example.test/home" },
						},
						"https-basic": { kind: "http-basic" },
					},
					...(identityCache === undefined ? {} : { identityCache }),
				}),
			);
			writeEnv(configDir, { [PASSWORD_VARIABLE]: "clerk-secret-sentinel" });
			const view = stageView(onlyEntry(readStageCatalog(configDir)), configDir);
			expect(JSON.stringify(view)).not.toContain("clerk-secret-sentinel");
			return Object.fromEntries(
				(view.apps[0]?.roles ?? []).map((role) => [role.role, role.cacheable]),
			);
		};
		expect(cacheableFor()).toEqual({
			automated: true,
			interactive: true,
			// The one recipe the driver cannot observe.
			basic: false,
			none: true,
		});
		// The stage-level opt-out wins over every recipe: nothing of it is cached,
		// so no role of it is worth calling cacheable.
		expect(cacheableFor(false)).toEqual({
			automated: false,
			interactive: false,
			basic: false,
			none: false,
		});
	});

	test("a refresh interval under the floor is raised to it, never above the TTL", () => {
		const boundsFor = (identityCache: StagePolicy["identityCache"]) =>
			effectiveIdentityCache({}, { identityCache } as StagePolicy);
		// A one-second interval would re-capture on nearly every browser call, which
		// is the per-call cost the interval exists to keep off the hot path (PERF-007).
		expect(boundsFor({ refreshSeconds: 1 })?.refreshMs).toBe(
			MIN_IDENTITY_CACHE_REFRESH_SECONDS * 1_000,
		);
		expect(boundsFor({ refreshSeconds: 0 })?.refreshMs).toBe(
			MIN_IDENTITY_CACHE_REFRESH_SECONDS * 1_000,
		);
		// Above the floor the declared value stands, up to the ceiling.
		expect(boundsFor({ refreshSeconds: 600 })?.refreshMs).toBe(600_000);
		expect(boundsFor({})?.refreshMs).toBe(
			DEFAULT_IDENTITY_CACHE.refreshSeconds * 1_000,
		);
	});
});
