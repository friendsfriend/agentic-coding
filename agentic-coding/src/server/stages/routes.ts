// The stage read surfaces (`add-stage-testing-foundation`, tasks 2.1 and 5.1).
//
// Two audiences, two routes, one catalog:
//
// * `GET /api/v1/stages` — the instance-authenticated surface the dashboard's
//   Settings section reads. It shows allow-listed stages *and* the excluded
//   files with their value-free diagnostics, because "why is my stage not
//   there" is the question the operator actually has.
// * `GET /api/v1/agent-env/stages[/{ident}]` — the owner-scoped surface a run's
//   `stage_info` tool reads. It resolves each declared version probe with a
//   bounded timeout and returns `not discoverable` rather than failing when a
//   host is down.
//
// `POST /api/v1/stages/credential` is the protected write of the section: it
// accepts one `{ variable, value }`, only for a key the catalog actually
// references, writes it with `upsertEnvFile` and answers with the new *status* —
// the value never comes back, and no diagnostic, log line or response of this
// module can contain it.
import fs from "node:fs";
import path from "node:path";
import type {
	AgentStagesResponse,
	ExcludedStageStatus,
	StageApiRequest,
	StageApiRequestResponse,
	StageCredentialRequest,
	StageCredentialResponse,
	StageStatus,
	StagesStatusResponse,
	StageTokenInfoRequest,
	StageTokenInfoResponse,
	StageVersionStatus,
} from "../../contracts/stages.ts";
import { upsertEnvFile } from "../../env-file.ts";
import { readJsonBody } from "../auth.ts";
import { environmentSecrets, redact } from "../environment/agent-routes.ts";
import {
	AGENT_STAGE_API_REQUEST_PATH,
	AGENT_STAGE_TOKEN_INFO_PATH,
	AGENT_STAGES_PATH,
	decodeRouteRequest,
	STAGES_CREDENTIAL_PATH,
} from "../protocol.ts";
import {
	StageApiError,
	stageApiRequestValue,
	stageTokenInfoValue,
} from "./api-request.ts";
import {
	readStageCatalog,
	type StageCatalog,
	type StageEntry,
	stageByIdent,
	stageCredentialVariables,
	stageRefusalReason,
	stageView,
} from "./catalog.ts";
import type { StageUsageRegistry } from "./limits.ts";
import {
	forgetStageTokens,
	type StageTokenStore,
	stageTokenStore,
} from "./oauth2.ts";

/** How long one version probe may take before it is `not discoverable`. */
export const VERSION_PROBE_TIMEOUT_MS = 5_000;
/** The longest version string a probe result carries. */
const MAX_VERSION_CHARS = 120;

/** A refusal of the stage surface, with the code the contract names. */
export class StageRouteError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "StageRouteError";
	}
}

export interface StageRouteDeps {
	/** The canonical configuration root; stages are never read from anywhere
	 * else (no repository overlay, no workflow worktree). */
	readonly configDir: string;
	/** Test seam: the app idents a stage may link. */
	readonly appIdents?: () => readonly string[];
	/** Test seam: the version probe. Defaults to a bounded `fetch`. */
	readonly probe?: (url: string) => Promise<unknown>;
	/** Test seam: the bound a probe is given, whoever supplies it. */
	readonly probeTimeoutMs?: number;
	/** The process's token store (`add-stage-oauth2-auth`). Omitted, the process
	 * store is used; tests pass their own. */
	readonly tokens?: StageTokenStore;
	/** The rolling-minute registry `stage_api_request` counts in. The browser
	 * routes read the same one, so one stage has one rate in this workflow. */
	readonly usage?: StageUsageRegistry;
	/** Test seam: the HTTP client of one stage API call. */
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/** The run's redactor: the configuration `.env` *and* the tokens this process
 * holds (`add-stage-oauth2-auth`, D4). A token is acquired at runtime, so it is
 * not an `.env` value; the store is the second source, and a stage that echoes a
 * token back in its own body is covered by it. */
function redactor(deps: StageRouteDeps): (value: unknown) => unknown {
	const secrets = [
		...environmentSecrets(deps.configDir),
		...(deps.tokens ?? stageTokenStore()).secrets(),
	].sort((left, right) => right.value.length - left.value.length);
	return (value) => redact(value, secrets);
}

/**
 * The same redactor, resolved *per use*.
 *
 * An OAuth 2.0 call acquires its token while it runs, so a secret set captured
 * before the call would not cover the very token the stage answered with. This
 * is the one place the difference matters, and it is a difference of *when* the
 * store is read, not of which values are secrets.
 */
function liveRedactor(deps: StageRouteDeps): (value: unknown) => unknown {
	return (value) => redactor(deps)(value);
}

/** The body of one OAuth 2.0 route, or a refusal that names the route rather
 * than a decoder. A body the contract rejects is the caller's mistake, so it is
 * a `400` and not the `500` an unhandled decode would produce. */
async function decodeAuthBody<T>(request: Request, path: string): Promise<T> {
	try {
		return decodeRouteRequest<T>(path, await readJsonBody(request));
	} catch (error) {
		throw new StageApiError(
			"stage-request-invalid",
			`this is not a valid ${path} request: ${
				error instanceof Error ? error.message : String(error)
			}`,
			400,
		);
	}
}

/** The catalog of one configuration root. Read per call: an edited stage file
 * applies to the next read. */
export function stageCatalog(deps: StageRouteDeps): StageCatalog {
	return readStageCatalog(deps.configDir, {
		...(deps.appIdents ? { appIdents: deps.appIdents } : {}),
	});
}

/** `GET /api/v1/stages`: structure, credential status and diagnostics, with no
 * version probe (the dashboard is a read, not a health check of every host). */
export function stagesStatusValue(deps: StageRouteDeps): StagesStatusResponse {
	const catalog = stageCatalog(deps);
	const value: StagesStatusResponse = {
		configDir: deps.configDir,
		stages: catalog.entries.map((entry) => stageStatus(entry, deps.configDir)),
		excluded: excludedStatuses(catalog),
	};
	return redactor(deps)(value) as StagesStatusResponse;
}

/** The refused stage files, as both read surfaces report them: the file, its
 * ident when it got that far, and its value-free diagnostics — so "my stage is
 * not there" is a readable answer rather than a silence. */
function excludedStatuses(catalog: StageCatalog): ExcludedStageStatus[] {
	return catalog.excluded.map((excluded) => ({
		file: excluded.file,
		...(excluded.ident === undefined ? {} : { ident: excluded.ident }),
		diagnostics: excluded.diagnostics.map(
			(diagnostic) => `${diagnostic.field}: ${diagnostic.message}`,
		),
	}));
}

/** `GET /api/v1/agent-env/stages[/{ident}]`. With `ident`, one stage and its
 * resolved version probes; without, every allow-listed stage. */
export async function agentStagesValue(
	deps: StageRouteDeps,
	ident?: string,
): Promise<AgentStagesResponse> {
	const catalog = stageCatalog(deps);
	if (ident !== undefined && ident !== "") {
		const entry = stageByIdent(catalog, ident);
		if (!entry)
			throw new StageRouteError(
				"stage-not-configured",
				stageRefusalReason(catalog, ident),
				404,
			);
		// One stage asked for by name: the answer is that stage, and its own
		// version probes. A refused ident is a 404 that names why it was refused
		// (`stageRefusalReason`), so the list is not repeated around it.
		return { stages: [await stageStatusProbed(deps, entry)], excluded: [] };
	}
	const stages = await Promise.all(
		catalog.entries.map((entry) => stageStatusProbed(deps, entry)),
	);
	return { stages, excluded: excludedStatuses(catalog) };
}

/** One stage with its declared version probes resolved. */
async function stageStatusProbed(
	deps: StageRouteDeps,
	entry: StageEntry,
): Promise<StageStatus> {
	const base = stageStatus(entry, deps.configDir);
	const apps = await Promise.all(
		base.apps.map(async (app) => {
			const probe = entry.stage.apps[app.key]?.version;
			if (!probe) return app;
			return { ...app, version: await resolveVersion(deps, app.url, probe) };
		}),
	);
	return { ...base, apps };
}

async function resolveVersion(
	deps: StageRouteDeps,
	baseUrl: string,
	probe: { readonly path: string; readonly field: string },
): Promise<StageVersionStatus> {
	const notDiscoverable: StageVersionStatus = {
		path: probe.path,
		field: probe.field,
		status: "not discoverable",
	};
	let url: URL;
	try {
		url = new URL(probe.path, baseUrl);
	} catch {
		return notDiscoverable;
	}
	// A probe is a read of *this application*: an absolute or protocol-relative
	// `path` would move it to a host the catalog never validated (the policy's own
	// deny list included), so a target off the app's origin is not discoverable
	// rather than fetched.
	const base = originOf(baseUrl);
	if (base === undefined || url.origin !== base) return notDiscoverable;
	const body = await boundedProbe(
		deps.probe ?? defaultProbe,
		url.toString(),
		deps.probeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS,
	).catch(() => undefined);
	if (body === undefined) return notDiscoverable;
	const value = readDotted(body, probe.field);
	if (value === undefined) return notDiscoverable;
	// The version is read from another system's answer, so it goes through the
	// same redactor as every other browser-shaped output.
	const redacted = redactor(deps)(String(value));
	return {
		path: probe.path,
		field: probe.field,
		status: "ok",
		value:
			typeof redacted === "string"
				? redacted.slice(0, MAX_VERSION_CHARS)
				: String(value).slice(0, MAX_VERSION_CHARS),
	};
}

/** The origin of a URL, or `undefined` when it is not one. */
function originOf(value: string): string | undefined {
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}

/** The default probe: one bounded GET, parsed as JSON when it is JSON. */ async function defaultProbe(
	url: string,
): Promise<unknown> {
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(VERSION_PROBE_TIMEOUT_MS),
		// A redirect would move the probe to a host the catalog never validated, so
		// a 3xx answer is an answer we do not follow.
		redirect: "manual",
	});
	if (!response.ok) return undefined;
	const text = await response.text();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/** Run one probe under the version bound, whoever supplied it: a probe that
 * never answers is `not discoverable`, never a hung read. The timer is cleared
 * on every path, so nothing is left armed behind a settling probe. */
function boundedProbe(
	probe: (url: string) => Promise<unknown>,
	url: string,
	timeoutMs: number,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => {
				resolve(undefined);
			},
			Math.max(1, timeoutMs),
		);
		timer.unref?.();
		probe(url).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/** One dotted field of a probe answer. */
function readDotted(value: unknown, field: string): unknown {
	let current: unknown = value;
	for (const segment of field.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return typeof current === "string" || typeof current === "number"
		? current
		: undefined;
}

/** One allow-listed stage as both surfaces report it. */
export function stageStatus(entry: StageEntry, configDir: string): StageStatus {
	const view = stageView(entry, configDir);
	return {
		ident: view.ident,
		displayName: view.displayName,
		environment: view.environment,
		system: view.system,
		access: view.access,
		planApproval: view.planApproval,
		exclusive: view.exclusive,
		apps: view.apps.map((app) => ({
			key: app.key,
			label: app.label,
			url: app.url,
			kind: app.kind,
			...(app.api === undefined ? {} : { api: app.api }),
			...(app.app === undefined ? {} : { app: app.app }),
			roles: app.roles.map((role) => ({
				role: role.role,
				...(role.login === undefined ? {} : { login: role.login }),
				...(role.loginKind === undefined ? {} : { loginKind: role.loginKind }),
				...(role.provider === undefined ? {} : { provider: role.provider }),
				...(role.grant === undefined ? {} : { grant: role.grant }),
				...(role.bearerOrigins === undefined
					? {}
					: { bearerOrigins: [...role.bearerOrigins] }),
				credentialStatus: role.credentialStatus,
				loginMode: role.loginMode,
				credentials: role.credentials.map((credential) => ({
					field: credential.field,
					variable: credential.variable,
					status: credential.status,
				})),
			})),
		})),
		origins: [...entry.origins],
		// The declared providers, with the *status* of their client credentials: a
		// role's token path is only as ready as the variables behind it. Omitted
		// entirely for a stage that declares none, so the foundation's read surface
		// is unchanged for every stage that predates OAuth 2.0.
		...(view.oauth2.providers.length === 0
			? {}
			: {
					oauth2: {
						providers: view.oauth2.providers.map((provider) => ({
							name: provider.name,
							tokenEndpoint: provider.tokenEndpoint,
							...(provider.authorizationEndpoint === undefined
								? {}
								: {
										authorizationEndpoint: provider.authorizationEndpoint,
									}),
							...(provider.audience === undefined
								? {}
								: { audience: provider.audience }),
							scope: [...provider.scope],
							clientAuth: provider.clientAuth ?? "basic",
							credentials: provider.credentials.map((credential) => ({
								field: credential.field,
								variable: credential.variable,
								status: credential.status,
							})),
						})),
					},
				}),
		readOnlyExceptions: view.readOnlyExceptions.map((exception) => ({
			origin: exception.origin,
			pathPrefix: exception.pathPrefix,
			methods: [...exception.methods],
		})),
		// The clamped bounds, the data conventions and the knowledge hints are part
		// of what a read surface reports: `stage_info` is how a run learns the
		// numbers it is held to, the cleanup a `writable` stage expects and which wiki
		// process to read first.
		limits: { ...view.limits },
		data: { ...view.data },
		wiki: { processes: [...view.wiki.processes] },
		diagnostics: view.diagnostics.map(
			(diagnostic) =>
				`${diagnostic.kind === "error" ? "error" : "warning"}: ${diagnostic.field}: ${diagnostic.message}`,
		),
	};
}

// ---------------------------------------------------------------------------
// Owner-scoped routing
// ---------------------------------------------------------------------------

/**
 * The stage routes of one run. Answers `undefined` for a path this module does
 * not own, so `app.ts` can keep handing the capability prefix on.
 */
export async function handleStageRoute(
	deps: StageRouteDeps,
	request: Request,
	url: URL,
	owner: string,
): Promise<Response | undefined> {
	const path = url.pathname;
	// The two OAuth 2.0 routes (`add-stage-oauth2-auth`) are siblings of the
	// catalog and are the only stage routes that take a body.
	if (
		path === AGENT_STAGE_API_REQUEST_PATH ||
		path === AGENT_STAGE_TOKEN_INFO_PATH
	)
		return await handleAuthRoute(deps, request, path, owner);
	if (path !== AGENT_STAGES_PATH && !path.startsWith(`${AGENT_STAGES_PATH}/`))
		return undefined;
	if (request.method.toUpperCase() !== "GET")
		return json(
			{ error: { code: "method", message: `${path} is read-only` } },
			405,
		);
	try {
		const ident =
			path === AGENT_STAGES_PATH
				? undefined
				: decodeURIComponent(path.slice(AGENT_STAGES_PATH.length + 1));
		if (ident !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(ident))
			throw new StageRouteError(
				"stage-not-configured",
				"a stage ident must match ^[a-z0-9][a-z0-9-]{0,62}$",
				400,
			);
		return json({ ok: true, value: await agentStagesValue(deps, ident) });
	} catch (error) {
		if (error instanceof StageRouteError)
			return json(
				{ error: { code: error.code, message: error.message } },
				error.status,
			);
		return json(
			{
				error: {
					code: "stage-read-failed",
					message: error instanceof Error ? error.message : String(error),
				},
			},
			500,
		);
	}
}

// ---------------------------------------------------------------------------
// OAuth 2.0 routes
// ---------------------------------------------------------------------------

/** `POST …/stage-api-request` and `POST …/stage-token-info`. One envelope per
 * call, the value redacted on the way out: a token the *stage* echoes back is
 * still a token. */
async function handleAuthRoute(
	deps: StageRouteDeps,
	request: Request,
	path: string,
	owner: string,
): Promise<Response> {
	if (request.method.toUpperCase() !== "POST")
		return json(
			{
				error: {
					code: "method",
					message: `${path} is answered over POST only`,
				},
			},
			405,
		);
	// Resolved per use, not once: the token this call acquires is one of the secrets
	// the answer has to be redacted of.
	const redactValue = liveRedactor(deps);
	try {
		if (path === AGENT_STAGE_API_REQUEST_PATH) {
			const decoded = await decodeAuthBody<StageApiRequest>(
				request,
				AGENT_STAGE_API_REQUEST_PATH,
			);
			const value: StageApiRequestResponse = await stageApiRequestValue(
				deps,
				decoded,
				owner,
				redactValue,
			);
			return json({ ok: true, value: redactValue(value) });
		}
		const decoded = await decodeAuthBody<StageTokenInfoRequest>(
			request,
			AGENT_STAGE_TOKEN_INFO_PATH,
		);
		const info: StageTokenInfoResponse = await stageTokenInfoValue(
			deps,
			decoded,
		);
		return json({ ok: true, value: redactValue(info) });
	} catch (error) {
		if (error instanceof StageApiError)
			return json(
				{
					error: {
						code: error.code,
						message: error.message,
						...(error.retryAfterMs === undefined
							? {}
							: { retryAfterMs: error.retryAfterMs }),
					},
				},
				error.status,
			);
		return json(
			{
				error: {
					code: "stage-auth-failed",
					message: error instanceof Error ? error.message : String(error),
				},
			},
			500,
		);
	}
}

// ---------------------------------------------------------------------------
// Credential flow
// ---------------------------------------------------------------------------

/**
 * Write one credential the catalog references.
 *
 * The key set is the catalog's own referenced variables, so this route can never
 * become a general writer of the configuration `.env`, and the answer is the new
 * status only. `/api/v1/stages/credential` is instance-authenticated, which is
 * what makes it a *protected* credential flow rather than a plain file write.
 */
export async function setStageCredential(
	deps: StageRouteDeps,
	body: StageCredentialRequest,
): Promise<StageCredentialResponse> {
	const catalog = stageCatalog(deps);
	const variables = stageCredentialVariables(catalog);
	if (!variables.has(body.variable))
		throw new StageRouteError(
			"credential-unknown",
			`no allow-listed stage references ${body.variable}; add it to a stage definition first`,
			404,
		);
	const file = path.join(deps.configDir, ".env");
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	upsertEnvFile(file, new Map([[body.variable, body.value]]));
	// The token this variable helped acquire is stale now: a rotation, a fixed
	// secret or a reissued refresh token has to reach the provider, not sit behind
	// a valid-looking entry in the store.
	const owner = variables.get(body.variable);
	if (owner !== undefined)
		forgetStageTokens({ stage: owner.stage }, deps.tokens);
	return { variable: body.variable, status: "set" };
}

/** Serve one instance-authenticated credential write. */
export async function handleStageCredentialRoute(
	deps: StageRouteDeps,
	request: Request,
): Promise<Response> {
	let body: StageCredentialRequest;
	try {
		body = decodeRouteRequest<StageCredentialRequest>(
			STAGES_CREDENTIAL_PATH,
			await readJsonBody(request),
		);
	} catch (error) {
		return json(
			{
				error: {
					code: "bad-request",
					message: error instanceof Error ? error.message : String(error),
				},
			},
			400,
		);
	}
	try {
		return json(await setStageCredential(deps, body));
	} catch (error) {
		if (error instanceof StageRouteError)
			return json(
				{ error: { code: error.code, message: error.message } },
				error.status,
			);
		return json(
			{
				error: {
					code: "credential-write-failed",
					message:
						error instanceof Error
							? // The write can fail for a filesystem reason; never for a value.
								error.message.replaceAll(body.value, "«redacted»")
							: String(error),
				},
			},
			500,
		);
	}
}
