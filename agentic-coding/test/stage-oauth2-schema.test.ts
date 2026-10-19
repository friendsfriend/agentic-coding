// The OAuth 2.0 configuration surface (`add-stage-oauth2-auth`, task 1.1).
//
// A stage file is operator-owned configuration, and the catalog is the boundary:
// this file asserts what it accepts (the `oauth2` role recipe, a provider table,
// a role that is unattended by construction) and what it refuses with a
// *value-free* diagnostic — an endpoint that is not https, an endpoint whose
// origin is not allow-listed, a credential that is a literal rather than a
// `${VAR}` reference, an unsupported grant, a `bearerOrigins` entry that is not
// an origin of the stage, and an oauth2 field on a role that is not one.
//
// Every assertion about a login mode reads the view the plan and `stage_info`
// also read, so "what the developer sees" and "what the server decided" cannot
// disagree in this file.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file writes the literal `${VARIABLE}` reference syntax a stage file uses, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	readStageCatalog,
	resolveStageOAuthCredential,
	stageByIdent,
	stageCredentialVariables,
	stageView,
} from "../src/server/stages/catalog.ts";

const CLIENT_SECRET_VALUE = "client-secret-value-do-not-leak";
const REFRESH_TOKEN_VALUE = "refresh-token-value-do-not-leak";

/** The one application every fixture below shares, unless a test replaces it. */
const API_APP = {
	label: "Grid API",
	url: "https://api.int.example.test",
	kind: "api",
	roles: {
		service: {
			login: "oauth2",
			provider: "idp",
			grant: "client_credentials",
			bearerOrigins: ["https://api.int.example.test"],
		},
	},
};

/** One stage file, with the oauth2 pieces a test wants to vary. */
function writeStage(
	overrides: Record<string, unknown> = {},
	env: Record<string, string> = {},
	/** The `stages/policy.json` body, when a test needs a policy at all. */
	policy?: Record<string, unknown>,
): string {
	const configDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "stage-oauth2-schema-"),
	);
	const defsDir = path.join(configDir, "stages", "definitions");
	fs.mkdirSync(defsDir, { recursive: true });
	if (policy !== undefined)
		fs.writeFileSync(
			path.join(configDir, "stages", "policy.json"),
			`${JSON.stringify(policy, null, 2)}\n`,
		);
	const definition = {
		ident: "grid-int",
		displayName: "Grid integration",
		environment: "integration",
		system: "grid",
		access: "writable",
		apps: { api: API_APP },
		oauth2: {
			providers: {
				idp: {
					tokenEndpoint: "https://login.example.test/oauth2/token",
					clientId: "${STAGE_GRID_INT_CLIENT_ID}",
					clientSecret: "${STAGE_GRID_INT_CLIENT_SECRET}",
					scope: ["api://grid/.default"],
				},
			},
		},
		allowedOrigins: [
			"https://api.int.example.test",
			"https://login.example.test",
		],
		...overrides,
	};
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(definition, null, 2)}\n`,
	);
	const values = {
		STAGE_GRID_INT_CLIENT_ID: "client-id-value",
		STAGE_GRID_INT_CLIENT_SECRET: CLIENT_SECRET_VALUE,
		STAGE_GRID_INT_REFRESH_TOKEN: REFRESH_TOKEN_VALUE,
		...env,
	};
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`${Object.entries(values)
			.map(([name, value]) => `${name}=${value}`)
			.join("\n")}\n`,
	);
	return configDir;
}

/** One provider override that keeps the fixture's client id and secret. */
function provider(
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		oauth2: {
			providers: {
				idp: {
					tokenEndpoint: "https://login.example.test/oauth2/token",
					clientId: "${STAGE_GRID_INT_CLIENT_ID}",
					clientSecret: "${STAGE_GRID_INT_CLIENT_SECRET}",
					...extra,
				},
			},
		},
	};
}

/** The diagnostics of the one stage file this helper writes, as
 * `kind: field message` lines. A file that fails to decode has no ident yet, so
 * the file name is what identifies it. */
function diagnostics(configDir: string): string[] {
	const catalog = readStageCatalog(configDir);
	const entry = stageByIdent(catalog, "grid-int");
	return [...catalog.diagnostics, ...(entry?.diagnostics ?? [])]
		.filter((diagnostic) => diagnostic.file === "grid-int.json")
		.map(
			(diagnostic) =>
				`${diagnostic.kind}: ${diagnostic.field} ${diagnostic.message}`,
		);
}

function errors(configDir: string): string[] {
	return diagnostics(configDir).filter((line) => line.startsWith("error:"));
}

/** The view of the one stage file, as `stage_info` and the plan read it. */
function viewOf(configDir: string) {
	const entry = stageByIdent(readStageCatalog(configDir), "grid-int");
	expect(entry).toBeDefined();
	if (!entry) throw new Error("the fixture stage is not allow-listed");
	return { entry, view: stageView(entry, configDir) };
}

describe("an oauth2 stage is valid configuration", () => {
	test("the provider, the role and the bearer origins validate, and the view names the recipe", () => {
		const configDir = writeStage();
		const catalog = readStageCatalog(configDir);
		const entry = stageByIdent(catalog, "grid-int");

		expect(catalog.excluded).toEqual([]);
		expect(entry).toBeDefined();
		if (!entry) return;
		expect(entry.stage.oauth2?.providers?.idp?.clientId).toBe(
			"${STAGE_GRID_INT_CLIENT_ID}",
		);

		const view = stageView(entry, configDir);
		const role = view.apps[0]?.roles[0];
		expect(role?.login).toBe("oauth2");
		expect(role?.loginKind).toBe("oauth2");
		expect(role?.provider).toBe("idp");
		expect(role?.grant).toBe("client_credentials");
		expect(role?.bearerOrigins).toEqual(["https://api.int.example.test"]);
		expect(role?.loginMode).toBe("automated");
		// The provider's credential status is names and presence, never a value.
		expect(view.oauth2?.providers[0]?.name).toBe("idp");
		expect(view.oauth2?.providers[0]?.credentials).toEqual([
			{
				field: "clientId",
				variable: "STAGE_GRID_INT_CLIENT_ID",
				status: "set",
			},
			{
				field: "clientSecret",
				variable: "STAGE_GRID_INT_CLIENT_SECRET",
				status: "set",
			},
		]);
		expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET_VALUE);
	});

	test("a missing client secret is `missing`, names the variable and makes the role unavailable", () => {
		const configDir = writeStage({}, { STAGE_GRID_INT_CLIENT_SECRET: "" });
		const { view } = viewOf(configDir);

		expect(view.oauth2?.providers[0]?.credentials).toContainEqual({
			field: "clientSecret",
			variable: "STAGE_GRID_INT_CLIENT_SECRET",
			status: "missing STAGE_GRID_INT_CLIENT_SECRET",
		});
		// A window cannot type a client secret: a missing reference is a `.env` gap
		// no hand-off could fill, so the role is `unavailable`.
		expect(view.apps[0]?.roles[0]?.loginMode).toBe("unavailable");
		expect(view.apps[0]?.roles[0]?.credentialStatus).toBe(
			"missing STAGE_GRID_INT_CLIENT_SECRET",
		);
	});

	test("the credential variables of the stage include the provider's, so Settings can set them", () => {
		const configDir = writeStage();
		const variables = stageCredentialVariables(readStageCatalog(configDir));

		expect([...variables.keys()]).toContain("STAGE_GRID_INT_CLIENT_ID");
		expect([...variables.keys()]).toContain("STAGE_GRID_INT_CLIENT_SECRET");
		expect(variables.get("STAGE_GRID_INT_CLIENT_SECRET")).toEqual({
			stage: "grid-int",
			app: "idp",
			role: "oauth2",
			field: "clientSecret",
		});
	});

	test("a provider value resolves through the function that turns a reference into a value", () => {
		const configDir = writeStage();
		const { entry } = viewOf(configDir);

		expect(
			resolveStageOAuthCredential(
				entry.stage,
				"idp",
				"clientSecret",
				configDir,
			),
		).toBe(CLIENT_SECRET_VALUE);
	});
});

describe("the oauth2 role's login mode", () => {
	test("a client_credentials role is automated, whatever the interactive-login policy says", () => {
		// The policy is written, not left at its default: the unattended grant has
		// to be `automated` under the strictest configuration too, because the
		// refusal it guards is a window this login never opens (TQV-002).
		expect(
			viewOf(writeStage({}, {}, { interactiveLogin: "never" })).view.apps[0]
				?.roles[0]?.loginMode,
		).toBe("automated");
		// And under the default policy, which is what a fresh configuration has.
		expect(viewOf(writeStage()).view.apps[0]?.roles[0]?.loginMode).toBe(
			"automated",
		);
	});

	test("a refresh_token role needs its refresh token set, and is unavailable without it", () => {
		const configDir = writeStage(
			{
				apps: {
					api: {
						label: "Grid API",
						url: "https://api.int.example.test",
						kind: "api",
						roles: {
							service: {
								login: "oauth2",
								provider: "idp",
								grant: "refresh_token",
								refreshToken: "${STAGE_GRID_INT_REFRESH_TOKEN}",
							},
						},
					},
				},
			},
			{ STAGE_GRID_INT_REFRESH_TOKEN: "" },
		);
		expect(viewOf(configDir).view.apps[0]?.roles[0]?.loginMode).toBe(
			"unavailable",
		);
	});

	test("the authorization_code grant is valid configuration, and its login is not this build's", () => {
		const grant = {
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						user: {
							login: "oauth2",
							provider: "idp",
							grant: "authorization_code",
						},
					},
				},
			},
		};
		// With the authorization endpoint the flow needs, the file is valid
		// configuration; the login itself is not this build's, so the mode is
		// `unavailable` rather than a hand-off no run could complete (USAB-003).
		// The browser flow itself belongs to `add-stage-oauth2-code-pkce`.
		const complete = writeStage({
			...grant,
			...provider({
				authorizationEndpoint: "https://login.example.test/oauth2/authorize",
			}),
		});
		expect(readStageCatalog(complete).excluded).toEqual([]);
		const role = viewOf(complete).view.apps[0]?.roles[0];
		expect(role?.grant).toBe("authorization_code");
		expect(role?.loginKind).toBe("oauth2");
		expect(role?.loginMode).toBe("unavailable");

		// Without it the catalog refuses the file rather than accepting a provider
		// that could never complete the flow.
		const incomplete = writeStage(grant);
		expect(errors(incomplete).join("\n")).toContain("authorizationEndpoint");
	});
});

describe("what the catalog refuses", () => {
	test("a credential that is a literal is refused without quoting it", () => {
		const configDir = writeStage({
			...provider({ clientId: "a-literal-client-id" }),
		});
		const reported = errors(configDir).join("\n");
		expect(reported).toContain("oauth2.providers.idp.clientId");
		expect(reported).toContain("${VARIABLE}");
		expect(reported).not.toContain("a-literal-client-id");
		expect(reported).not.toContain(CLIENT_SECRET_VALUE);
	});

	test("a token endpoint outside the allow-list, or not https, is refused", () => {
		const outside = writeStage({
			...provider({ tokenEndpoint: "https://tokens.other.example.test/token" }),
		});
		expect(errors(outside).join("\n")).toContain("allowedOrigins");

		const insecure = writeStage({
			...provider({ tokenEndpoint: "http://login.example.test/oauth2/token" }),
		});
		expect(errors(insecure).join("\n")).toContain("https");
	});

	test("a bearer origin that is not an origin of the stage is refused, and the diagnostic is value-free", () => {
		const configDir = writeStage({
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: {
							login: "oauth2",
							provider: "idp",
							grant: "client_credentials",
							bearerOrigins: ["https://elsewhere.example.test"],
						},
					},
				},
			},
		});
		const reported = errors(configDir).join("\n");
		expect(reported).toContain("bearerOrigins");
		expect(reported).not.toContain("elsewhere.example.test");
	});

	test("an unsupported grant never decodes, and the file is excluded rather than guessed at", () => {
		const configDir = writeStage({
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: { login: "oauth2", provider: "idp", grant: "password" },
					},
				},
			},
		});
		const catalog = readStageCatalog(configDir);
		expect(catalog.entries).toEqual([]);
		expect(catalog.excluded[0]?.file).toBe("grid-int.json");
		const reported = errors(configDir).join("\n");
		expect(reported).toContain("roles.service.grant");
		// Only the grants the capability names are offered.
		expect(reported).toContain("client_credentials");
		expect(reported).toContain("refresh_token");
		expect(reported).toContain("authorization_code");
		expect(reported).not.toContain("password");
	});

	test("a refresh_token grant without a refresh token reference is refused", () => {
		const configDir = writeStage({
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: {
							login: "oauth2",
							provider: "idp",
							grant: "refresh_token",
						},
					},
				},
			},
		});
		expect(errors(configDir).join("\n")).toContain("refreshToken");
	});

	test("an oauth2 field on a role that is not one is refused, so a leftover never installs a token", () => {
		const configDir = writeStage({
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: {
							login: "web-form",
							username: "${STAGE_GRID_INT_CLIENT_ID}",
							password: "${STAGE_GRID_INT_CLIENT_SECRET}",
							bearerOrigins: ["https://api.int.example.test"],
						},
					},
				},
			},
			logins: {
				"web-form": {
					kind: "form",
					steps: [{ fields: [{ credential: "password", label: "Password" }] }],
				},
			},
		});
		const reported = errors(configDir).join("\n");
		expect(reported).toContain("bearerOrigins");
		expect(reported).toContain("oauth2");
	});

	test("a provider the role names but the stage does not declare is refused", () => {
		const configDir = writeStage({
			...provider(),
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: {
							login: "oauth2",
							provider: "nope",
							grant: "client_credentials",
						},
					},
				},
			},
		});
		expect(errors(configDir).join("\n")).toContain("nope");
	});

	test("a login form field on an oauth2 role is a warning: the recipe types nothing", () => {
		const configDir = writeStage({
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: {
							login: "oauth2",
							provider: "idp",
							grant: "client_credentials",
							username: "${STAGE_GRID_INT_CLIENT_ID}",
						},
					},
				},
			},
		});
		expect(errors(configDir)).toEqual([]);
		expect(diagnostics(configDir).join("\n")).toContain("warning");
	});

	test("`insecureHttp` never exempts a provider endpoint, so a token still needs https", () => {
		// The flag admits an http application on a trusted network. It must not admit
		// the endpoint a client secret is posted to, or the flag would silently move
		// the secret onto the wire in clear (SEC-003).
		const configDir = writeStage({
			insecureHttp: true,
			...provider({
				tokenEndpoint: "http://login.int.example.test/oauth2/token",
			}),
		});
		const reported = errors(configDir).join("\n");
		expect(reported).toContain("oauth2.providers.idp.tokenEndpoint");
		expect(reported).toContain("https");
	});

	test("two roles that would rotate the same refresh token are refused", () => {
		// A provider that rotates keeps only its last refresh token, so two roles
		// sharing one reference would invalidate each other's renewal (CONC-003).
		const configDir = writeStage({
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: {
							login: "oauth2",
							provider: "idp",
							grant: "refresh_token",
							refreshToken: "${STAGE_GRID_INT_REFRESH_TOKEN}",
							bearerOrigins: ["https://api.int.example.test"],
						},
						"service-two": {
							login: "oauth2",
							provider: "idp",
							grant: "refresh_token",
							refreshToken: "${STAGE_GRID_INT_REFRESH_TOKEN}",
							bearerOrigins: ["https://api.int.example.test"],
						},
					},
				},
			},
		});
		const reported = errors(configDir).join("\n");
		expect(reported).toContain("service-two");
		expect(reported).toContain("refresh token");
		// Value-free: the diagnostic names the variable, never what it holds.
		expect(reported).not.toContain(REFRESH_TOKEN_VALUE);
	});

	test("an operator's own recipe named `oauth2` still works, and its role is not reinterpreted", () => {
		// A stage file written before this build may carry a form recipe called
		// `oauth2`; a role that points at it and declares no provider is that recipe,
		// and the reuse of the built-in name is reported rather than silently
		// applied (MIG-001).
		const configDir = writeStage({
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: {
							login: "oauth2",
							username: "${STAGE_GRID_INT_CLIENT_ID}",
							password: "${STAGE_GRID_INT_CLIENT_SECRET}",
						},
					},
				},
			},
			logins: {
				oauth2: {
					kind: "form",
					steps: [{ fields: [{ credential: "password", label: "Password" }] }],
				},
			},
		});

		expect(errors(configDir)).toEqual([]);
		expect(diagnostics(configDir).join("\n")).toContain("warning");
		const role = viewOf(configDir).view.apps[0]?.roles[0];
		// The declared recipe, not the built-in one: a form recipe with its references
		// set is still the automated form login it was before this build.
		expect(role?.loginKind).toBe("form");
		expect(role?.grant).toBeUndefined();
		expect(role?.loginMode).toBe("automated");
	});

	test("an oauth2 role has to say `login: oauth2`, so a provider is never half-declared", () => {
		const configDir = writeStage({
			apps: {
				api: {
					label: "Grid API",
					url: "https://api.int.example.test",
					kind: "api",
					roles: {
						service: {
							login: "web-form",
							provider: "idp",
							grant: "client_credentials",
						},
					},
				},
			},
		});
		expect(errors(configDir).join("\n")).toContain("oauth2");
	});
});
