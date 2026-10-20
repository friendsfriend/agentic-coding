// The browser tools of a durable agent run (`add-agent-browser-sessions`).
//
// `agentic.browser` gives every durable run — read-only verifiers included — the
// tools that drive a real headless browser against the apps its workflow holds.
// They never talk to Playwright themselves: every call goes to the server's
// owner-scoped `/api/v1/agent-env/browser/*` surface with the capability the run
// already holds, so a run can only ever drive its own sessions and can only
// resolve an app endpoint it actually holds.
//
// Two contract details are deliberate:
//
// * **`browser_snapshot` before acting.** The action tools take a `ref` from the
//   latest snapshot (preferred) or a Playwright selector. A ref that snapshot did
//   not produce is refused rather than silently resolving to another element.
// * **A screenshot is returned to the model.** It is an image content block, so
//   the model sees the page; it becomes evidence only when `evidence: true`, and
//   a recording leaves a file behind only when `keep: true`.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
	AGENT_BROWSER_ACTION_PATH,
	AGENT_BROWSER_CLOSE_PATH,
	AGENT_BROWSER_CONSOLE_PATH,
	AGENT_BROWSER_EVAL_PATH,
	AGENT_BROWSER_LOGIN_PATH,
	AGENT_BROWSER_LOGIN_WAIT_PATH,
	AGENT_BROWSER_NETWORK_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SCRIPT_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
	AGENT_BROWSER_STAGE_JOURNAL_PATH,
	AGENT_BROWSER_STAGE_STEP_PATH,
	AGENT_BROWSER_STAGE_WAIT_PATH,
	AGENT_BROWSER_WAIT_PATH,
} from "../server/protocol.ts";
import {
	ENVIRONMENT_OWNER_HEADER,
	ENVIRONMENT_TOKEN_ENV,
	ENVIRONMENT_URL_ENV,
	environmentOwnerFor,
} from "./environment-capability.ts";
import type { RunContextLookup } from "./tools.ts";

export const BROWSER_EXTENSION = "agentic.browser";

/** Tool output bound: a larger view is truncated rather than flooding context. */
const MAX_RESULT_CHARS = 40_000;
const READ_TIMEOUT_MS = 120_000;
const ACTION_TIMEOUT_MS = 180_000;
/** One `stage_login_wait` call: the server caps the block at 600 s, and the
 * client bound is a little above it so the server's own answer arrives first. */
const LOGIN_WAIT_TIMEOUT_MS = 610_000;
const NAVIGATION_TIMEOUT_MS = 120_000;
const RECORDING_TIMEOUT_MS = 180_000;
/** A `stage_step` or `stage_journal` call is a page read plus a file write. */
const JOURNAL_TIMEOUT_MS = 60_000;
/** One `stage_wait`: the server caps its own poll at the stage's
 * `maxWaitSeconds`, and the client bound sits just above the largest cap so the
 * server's own answer arrives first. */
const STAGE_WAIT_TIMEOUT_MS = 660_000;

type ContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };
type Result = { content: ContentBlock[]; isError?: boolean };

function text(value: unknown): Result {
	const raw =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return {
		content: [
			{
				type: "text",
				text:
					raw.length > MAX_RESULT_CHARS
						? `${raw.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`
						: raw,
			},
		],
	};
}

function failure(message: string): Result {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** One authenticated call to the server's owner-scoped browser surface.
 * Resolves to the envelope's `value`; rejects with the server's message, which
 * already carries the refusal code (`app-not-held`, `script-timeout`, …). */
async function call(
	env: Readonly<Record<string, string>>,
	method: "GET" | "POST",
	path: string,
	init: { body?: unknown; timeoutMs: number },
): Promise<unknown> {
	const binding = bindingOf(env);
	if (!binding) throw new Error(NO_BINDING);
	const response = await fetch(`${binding.url}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${binding.token}`,
			[ENVIRONMENT_OWNER_HEADER]: binding.owner,
			...(init.body === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		signal: AbortSignal.timeout(init.timeoutMs),
	});
	const parsed = (await response.json().catch(() => undefined)) as
		| {
				ok?: boolean;
				value?: unknown;
				error?: { code?: string; message?: string };
		  }
		| undefined;
	if (!response.ok || !parsed || parsed.ok === false || parsed.error) {
		const code = parsed?.error?.code;
		throw new Error(
			`${parsed?.error?.message ?? `the browser server answered ${response.status}`}${code ? ` [${code}]` : ""}`,
		);
	}
	return parsed.value;
}

interface BrowserBinding {
	readonly url: string;
	readonly token: string;
	readonly owner: string;
}

function bindingOf(
	env: Readonly<Record<string, string>>,
): BrowserBinding | undefined {
	const url = env[ENVIRONMENT_URL_ENV];
	const token = env[ENVIRONMENT_TOKEN_ENV];
	const workflowId = env.HERDR_WORKFLOW_ID;
	if (!url || !token || !workflowId) return undefined;
	return { url, token, owner: environmentOwnerFor(workflowId) };
}

const NO_BINDING =
	"this run has no agent environment capability (the workflow server did not provide one); the browser tools are unavailable";

const SessionParameter = Type.Optional(
	Type.String({
		description:
			"Which session to use: the run's own pages are addressed by name, and the one opened without a name is `default`.",
	}),
);

const TargetParameters = {
	ref: Type.Optional(
		Type.String({
			description:
				"An element ref from the latest browser_snapshot (`[ref=eN]`). Preferred over a selector.",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description:
				"An optional Playwright selector, when no snapshot ref names the element.",
		}),
	),
};

const BrowserOpenParameters = Type.Object({
	url: Type.Optional(
		Type.String({
			description:
				"The URL to open. Any URL is allowed, except in a session already bound to a stage: there the URL's origin must be one the stage allow-lists (`origin-not-allowed` otherwise).",
		}),
	),
	app: Type.Optional(
		Type.String({
			description:
				"An app ident from env_list, instead of a raw url; requires this workflow to hold the app.",
		}),
	),
	endpoint: Type.Optional(
		Type.String({
			description:
				"The endpoint name the app exports (from env_start's endpoints), resolved to its URL.",
		}),
	),
	stage: Type.Optional(
		Type.String({
			description:
				"An allow-listed stage ident from stage_info. Opens the stage's application at its configured URL and binds the session to that stage for the session's whole life: every main-frame navigation stays on the stage's allow-list, a read-only stage refuses state-changing requests, and stage_login becomes available. An unknown or refused stage answers `stage-not-configured`.",
		}),
	),
	stageApp: Type.Optional(
		Type.String({
			description:
				"The stage application key to open (from stage_info), required with `stage`.",
		}),
	),
	stageRole: Type.Optional(
		Type.String({
			description:
				'The role whose cached sign-in this session should start from (from stage_info). With a live cache entry for `(stage, stageRole)` the server installs its cookies and storage before the page\'s first request, so stage_login often reaches the success condition without a developer prompt and answers `identity: "cache"`. Absent means an empty browser, which is what every stage session did before. A role the application does not declare answers `stage-role-unknown`.',
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"An optional path appended to the stage application's configured URL.",
		}),
	),
	session: SessionParameter,
	viewport: Type.Optional(
		Type.Object({
			width: Type.Number({ description: "Viewport width in CSS pixels." }),
			height: Type.Number({ description: "Viewport height in CSS pixels." }),
		}),
	),
});

const BrowserSessionParameters = Type.Object({
	session: SessionParameter,
});

/** The credential reference `browser_fill` accepts instead of a literal value. */
const CredentialParameter = Type.Optional(
	Type.Object(
		{
			app: Type.String({
				description: "The stage application key the role belongs to.",
			}),
			role: Type.String({ description: "The role name of that application." }),
			field: Type.Union(
				[
					Type.Literal("username"),
					Type.Literal("password"),
					Type.Literal("totp"),
				],
				{
					description:
						"Which credential of the role to fill. A `totp` field is filled with a code computed now from the referenced secret.",
				},
			),
		},
		{
			description:
				"Fill the resolved credential of one role field instead of a literal `value`, on a session bound to a stage. The value never travels: the server reads it from the configuration `.env`. Use this rather than typing a credential you were told about, and never pass a credential as `value`.",
		},
	),
);

/** One tool per action, so the model never has to remember a discriminator. */
function actionTool(
	lookup: RunContextLookup,
	action: "click" | "fill" | "press" | "select" | "hover",
	name: string,
	description: string,
	specific: Record<string, unknown>,
) {
	return defineTool({
		name,
		description,
		parameters: Type.Object({
			...TargetParameters,
			session: SessionParameter,
			...specific,
		}),
		execute: async (args, api) => {
			const run = lookup(api.conversationId);
			if (!run) return failure(`${name}: run context unavailable`);
			const extra = args as Record<string, unknown>;
			const body: Record<string, unknown> = {
				action,
				...(extra.ref === undefined ? {} : { ref: extra.ref }),
				...(extra.selector === undefined ? {} : { selector: extra.selector }),
				...(extra.session === undefined ? {} : { session: extra.session }),
				...(extra.value === undefined ? {} : { value: extra.value }),
				...(extra.credential === undefined
					? {}
					: { credential: extra.credential }),
				...(extra.key === undefined ? {} : { key: extra.key }),
				...(extra.values === undefined ? {} : { values: extra.values }),
				...(extra.timeoutMs === undefined
					? {}
					: { timeoutMs: extra.timeoutMs }),
			};
			try {
				return text(
					await call(run.env, "POST", AGENT_BROWSER_ACTION_PATH, {
						timeoutMs: ACTION_TIMEOUT_MS,
						body,
					}),
				);
			} catch (error) {
				return failure(`${name}: ${message(error)}`);
			}
		},
	});
}

const BrowserWaitParameters = Type.Object({
	...TargetParameters,
	session: SessionParameter,
	text: Type.Optional(
		Type.String({ description: "Wait until this text is visible." }),
	),
	url: Type.Optional(
		Type.String({ description: "Wait until the URL matches this pattern." }),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "How long to wait, in ms." }),
	),
});

const BrowserEvalParameters = Type.Object({
	code: Type.String({
		description:
			"JavaScript evaluated in the page; the resolved value is returned.",
	}),
	session: SessionParameter,
	timeoutMs: Type.Optional(
		Type.Number({ description: "How long the evaluation may take, in ms." }),
	),
});

const BrowserLogParameters = Type.Object({
	session: SessionParameter,
	level: Type.Optional(
		Type.String({
			description: "Keep only console entries of this level (browser_console).",
		}),
	),
	status: Type.Optional(
		Type.Number({
			description: "Keep only responses with this status (browser_network).",
		}),
	),
	url: Type.Optional(
		Type.String({
			description: "Keep only entries whose URL contains this substring.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "How many entries to return (newest first)." }),
	),
});

const BrowserScreenshotParameters = Type.Object({
	...TargetParameters,
	session: SessionParameter,
	fullPage: Type.Optional(
		Type.Boolean({ description: "Capture the whole page, not the viewport." }),
	),
	evidence: Type.Optional(
		Type.Boolean({
			description:
				"Store the screenshot as evidence (default false: it is only returned to you).",
		}),
	),
	view: Type.Optional(
		Type.Boolean({
			description:
				"`view: false` stores the screenshot (needs `evidence: true`) and answers with the evidence id and caption only, so a long flow test does not inflate your context with images you would not inspect anyway.",
		}),
	),
	caption: Type.Optional(
		Type.String({
			description:
				"One line the developer reads next to the evidence, saying what it shows.",
		}),
	),
});

const StageWaitParameters = Type.Object({
	session: SessionParameter,
	until: Type.Object({
		text: Type.Optional(
			Type.String({ description: "Wait until this text is on the page." }),
		),
		selector: Type.Optional(
			Type.String({ description: "Wait until this CSS selector matches." }),
		),
		url: Type.Optional(
			Type.String({
				description:
					"Wait until the URL matches this pattern (`*` wildcards; without one it is a substring).",
			}),
		),
		mail: Type.Optional(
			Type.Object({
				to: Type.Optional(
					Type.String({
						description: "Mailpit search: the recipient address.",
					}),
				),
				subject: Type.Optional(
					Type.String({ description: "Mailpit search: the subject." }),
				),
			}),
		),
	}),
	reload: Type.Optional(
		Type.Boolean({
			description:
				"Re-open the session's current URL between polls (a mail-driven page has to be re-read to show the message's effect).",
		}),
	),
	intervalSeconds: Type.Optional(
		Type.Number({ description: "How often to poll, in seconds (default 5)." }),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"How long to wait, in seconds; capped by the stage's `maxWaitSeconds`.",
		}),
	),
});

const StageStepParameters = Type.Object({
	session: SessionParameter,
	label: Type.String({
		description:
			"The step itself, in the operator's words (e.g. `submit the request`). The server adds the time, the application, the role, the URL and — while a recording runs — the segment and offset.",
	}),
	expected: Type.Optional(
		Type.String({ description: "What should have happened, if it matters." }),
	),
	observed: Type.Optional(
		Type.String({ description: "What actually happened." }),
	),
	captures: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Values this step produced, as name → value (a reference number, a status, an amount). Redacted before the journal is written.",
		}),
	),
	evidence: Type.Optional(
		Type.Array(
			Type.String({
				description: "The id of a screenshot or video already attached.",
			}),
			{
				description:
					"The evidence ids this step shows. An id the manifest does not hold is refused.",
			},
		),
	),
	knowledge: Type.Optional(
		Type.Object({
			concept: Type.String({
				description: "The process concept or rule the step illustrates.",
			}),
			section: Type.Optional(
				Type.String({ description: "Where the concept is documented." }),
			),
			kind: Type.Union(
				[
					Type.Literal("confirmed"),
					Type.Literal("contradicted"),
					Type.Literal("missing"),
					Type.Literal("new"),
				],
				{
					description:
						"What the step showed about that concept: confirmed, contradicted, missing or new.",
				},
			),
			suspectedCause: Type.Optional(
				Type.Union(
					[
						Type.Literal("product-change"),
						Type.Literal("regression"),
						Type.Literal("unknown"),
					],
					{
						description:
							"For a contradiction: whether the product changed on purpose, regressed, or you cannot tell.",
					},
				),
			),
		}),
	),
});

const BrowserRecordParameters = Type.Object({
	session: SessionParameter,
	keep: Type.Optional(
		Type.Boolean({
			description:
				"browser_record_stop only: keep the video (and its poster) as evidence. `false` deletes it.",
		}),
	),
	caption: Type.Optional(
		Type.String({
			description: "browser_record_stop only: what the recording shows.",
		}),
	),
});

const BrowserScriptParameters = Type.Object({
	code: Type.String({
		description:
			"Playwright JavaScript, run as an async function of (page, context, expect) against this session.",
	}),
	session: SessionParameter,
	save: Type.Optional(
		Type.Boolean({
			description:
				"Store a rerunnable repro.spec.ts (wrapped in a @playwright/test spec with the page URL) as script evidence.",
		}),
	),
	caption: Type.Optional(
		Type.String({ description: "What the saved spec reproduces." }),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"How long the script may run, in ms (default 60s, max 10min).",
		}),
	),
});

/** `agentic.browser`: the browser tool surface of one durable run. */
export function createBrowserExtension(lookup: RunContextLookup) {
	return defineExtension({
		name: BROWSER_EXTENSION,
		tools: [
			defineTool({
				name: "browser_open",
				description: [
					"Open a page in a headless browser and get back the session, URL and viewport.",
					"Give a raw `url`, or an `app` plus `endpoint` from env_list/env_start — an endpoint resolves only while this workflow holds that app, and otherwise fails with `app-not-held` naming the holder.",
					"`session` opens (or reuses) a named page; the unnamed session is `default`. Sessions are isolated browser contexts, capped by browser.max_sessions with FIFO queueing and closed when the run ends or idles past its TTL.",
					"Give `stage` plus `stageApp` (both from stage_info) to open a hosted stage application instead: the URL comes from the stage catalog, and the session stays on the stage's origin allow-list for its whole life.",
					"Add `stageRole` to start that session from the role's cached sign-in: the server installs the cached cookies and storage before the page's first request, and stage_login reports `identity: \"cache\"` when the application accepts them. The cache is bounded, exists only in this server's memory, and its values are never returned or stored anywhere.",
					// The browser is the server's own, not a configured service: an agent that
					// went looking for the `playwright-server` infrastructure (or port 3050)
					// spent calls on something this surface never uses.
					"The browser is the workflow server's own: one Playwright-driven Chromium in this process, launched locally from an installed system Chrome or from the browser installed under this configuration; it does not use the configured playwright-server infrastructure service.",
					"Call browser_snapshot next: the action tools take the refs it returns.",
				].join(" "),
				parameters: BrowserOpenParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_open: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_OPEN_PATH, {
								timeoutMs: NAVIGATION_TIMEOUT_MS,
								body: {
									...(args.url === undefined ? {} : { url: args.url }),
									...(args.app === undefined ? {} : { app: args.app }),
									...(args.endpoint === undefined
										? {}
										: { endpoint: args.endpoint }),
									...(args.stage === undefined ? {} : { stage: args.stage }),
									...(args.stageApp === undefined
										? {}
										: { stageApp: args.stageApp }),
									...(args.stageRole === undefined
										? {}
										: { stageRole: args.stageRole }),
									...(args.path === undefined ? {} : { path: args.path }),
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.viewport === undefined
										? {}
										: { viewport: args.viewport }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_open: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_login",
				description: [
					"Log a stage-bound session in with the role's declared recipe: the server resolves the role's credential references from the configuration `.env` at call time, types them and waits for the login to complete.",
					"Use it on a session opened with `browser_open({ stage, stageApp })`; it answers the sanitized landing URL, or `credential-missing` naming the variable to set in Settings → Stages, `login-step-not-found`, `login-mfa-required` (the page asks for a second factor the recipe does not provide), `login-timeout`, `login-failed` or `login-not-required` for an application without roles.",
					"When no credentials are configured (or the role's login needs a step the server cannot automate), it answers `login-needs-user` and hands the login to the developer in a visible, agentic-coding-owned browser window. Then call `stage_login_wait` and wait *inside* that tool — the run is not blocked, so never hand off `blocked` for a hand-off. Its terminal outcomes are `ok`, `login-handoff-unverified`, `login-handoff-timeout`, `login-handoff-aborted` and `login-failed` (the sign-in ended without a token).",
					"An `oauth2` role whose grant is `authorization_code` is a hand-off too: the window opens on the provider's own sign-in page and the server receives the provider's redirect on a loopback receiver it opened for this one login, so nothing has to be pasted back and no code or token ever reaches this call.",
					"Its arguments, results, errors and telemetry never contain a credential value — do not try to read one, and never pass one to another tool. While the hand-off runs the session is held by the developer: every other browser tool on it is refused with `session-held-by-user`.",
				].join(" "),
				parameters: Type.Object({
					app: Type.String({
						description: "The stage application key to log in to.",
					}),
					role: Type.String({
						description:
							"The role to log in as (from stage_info), e.g. a read-only clerk role.",
					}),
					session: SessionParameter,
				}),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_login: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_LOGIN_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									app: args.app,
									role: args.role,
									...(args.session === undefined
										? {}
										: { session: args.session }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_login: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_login_wait",
				description: [
					"Wait in the server for the login hand-off a `stage_login` call started on this session. The block is bounded by the smaller of the hand-off's remaining deadline and 600 s per call; each call counts as one stage action, and no model turn is spent while it waits.",
					"It answers `login-needs-user` again while the developer is still logging in (call it once more), or one terminal outcome: `ok` with `via`, `verified` and the landing URL; `login-handoff-unverified` when the developer chose Done but the declared success condition did not hold; `login-handoff-timeout` when the deadline passed; `login-handoff-aborted` with `by` (`developer`, `agent`, `window-closed`, `run-ended`); `login-failed` when the sign-in ended without a token (a `state` mismatch, the provider's own error, or a refused exchange).",
					"A terminal outcome means the login did not happen and the run is blocked with that code as its reason — report it through the normal handoff path with that reason rather than retrying blindly; a retry is a fresh `stage_login`. Do not call this for a session with no pending hand-off.",
				].join(" "),
				parameters: Type.Object({
					session: SessionParameter,
					timeoutSec: Type.Optional(
						Type.Number({
							description:
								"How long this call may block, in seconds. The server caps it at 600 s and at the hand-off's remaining deadline, whichever is smaller.",
						}),
					),
				}),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_login_wait: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_LOGIN_WAIT_PATH, {
								timeoutMs: LOGIN_WAIT_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.timeoutSec === undefined
										? {}
										: { timeoutSec: args.timeoutSec }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_login_wait: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_snapshot",
				description:
					"Return the accessibility tree of the session's page with `[ref=eN]` element refs. Take a snapshot before acting, and pass the refs it names to browser_click/fill/press/select/hover.",
				parameters: BrowserSessionParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_snapshot: run context unavailable");
					try {
						const value = (await call(
							run.env,
							"POST",
							AGENT_BROWSER_SNAPSHOT_PATH,
							{
								timeoutMs: READ_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
								},
							},
						)) as { url?: string; snapshot?: string; refs?: number };
						return {
							content: [
								{
									type: "text",
									text: `url: ${value.url ?? ""}\nrefs: ${value.refs ?? 0}\n\n${(value.snapshot ?? "").slice(0, MAX_RESULT_CHARS)}`,
								},
							],
						};
					} catch (error) {
						return failure(`browser_snapshot: ${message(error)}`);
					}
				},
			}),
			actionTool(
				lookup,
				"click",
				"browser_click",
				"Click the element named by a ref from the latest browser_snapshot (preferred) or a selector.",
				{},
			),
			actionTool(
				lookup,
				"fill",
				"browser_fill",
				"Fill an input named by a ref from the latest browser_snapshot (preferred) or a selector with `value` — or, on a session bound to a stage, with `credential: { app, role, field }`, which the server resolves from the configuration `.env` so the value never enters this conversation.",
				{
					value: Type.Optional(
						Type.String({
							description: "The text to type into the field.",
						}),
					),
					credential: CredentialParameter,
				},
			),
			actionTool(
				lookup,
				"press",
				"browser_press",
				"Press `key` (for example Enter) on the element named by a ref from the latest browser_snapshot (preferred) or a selector.",
				{ key: Type.String({ description: "The key to press, e.g. Enter." }) },
			),
			actionTool(
				lookup,
				"select",
				"browser_select",
				"Choose one or more options (by value or label) in a `<select>` named by a ref from the latest browser_snapshot (preferred) or a selector.",
				{
					values: Type.Array(Type.String(), {
						description: "The option value(s) or label(s) to select.",
					}),
				},
			),
			actionTool(
				lookup,
				"hover",
				"browser_hover",
				"Hover the element named by a ref from the latest browser_snapshot (preferred) or a selector.",
				{},
			),
			defineTool({
				name: "browser_wait",
				description:
					"Wait until a ref/selector is visible, until `text` is visible, or until the URL matches `url` — bounded by `timeoutMs`.",
				parameters: BrowserWaitParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_wait: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_WAIT_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.ref === undefined ? {} : { ref: args.ref }),
									...(args.selector === undefined
										? {}
										: { selector: args.selector }),
									...(args.text === undefined ? {} : { text: args.text }),
									...(args.url === undefined ? {} : { url: args.url }),
									...(args.timeoutMs === undefined
										? {}
										: { timeoutMs: args.timeoutMs }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_wait: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_wait",
				description: [
					"Poll one condition *inside the server* until it holds or the bound elapses, and answer once — so a wait costs one tool call instead of one per poll.",
					"`until` takes exactly one of `text`, `selector`, `url` or `mail` (the last reads the stage's Mailpit mail catcher, by `to` and/or `subject`).",
					"The bound is the stage's `maxWaitSeconds`; `reload: true` re-opens the session's URL between polls.",
				].join(" "),
				parameters: StageWaitParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_wait: run context unavailable");
					const until = args.until as {
						text?: string;
						selector?: string;
						url?: string;
						mail?: { to?: string; subject?: string };
					};
					const named = [
						until.text !== undefined,
						until.selector !== undefined,
						until.url !== undefined,
						until.mail !== undefined,
					].filter(Boolean).length;
					if (named !== 1)
						return failure(
							"stage_wait: `until` takes exactly one of text, selector, url or mail",
						);
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_WAIT_PATH, {
								timeoutMs: STAGE_WAIT_TIMEOUT_MS,
								body: {
									until,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.reload === undefined ? {} : { reload: args.reload }),
									...(args.intervalSeconds === undefined
										? {}
										: { intervalSeconds: args.intervalSeconds }),
									...(args.timeoutSeconds === undefined
										? {}
										: { timeoutSeconds: args.timeoutSeconds }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_wait: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_step",
				description: [
					"Append one step to this workflow's journal, which becomes the `stage-flow.html` page the developer reads: the step, what it expected and observed, the values it captured, the evidence it shows, and what it taught about the process being tested.",
					"The server stamps the time, the session's application and role, the sanitized URL and — while a recording runs — the segment and the offset into it, so you never write a timestamp or a link yourself; everything is redacted on write.",
				].join(" "),
				parameters: StageStepParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_step: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_STEP_PATH, {
								timeoutMs: JOURNAL_TIMEOUT_MS,
								body: {
									label: args.label,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.expected === undefined
										? {}
										: { expected: args.expected }),
									...(args.observed === undefined
										? {}
										: { observed: args.observed }),
									...(args.captures === undefined
										? {}
										: { captures: args.captures }),
									...(args.evidence === undefined
										? {}
										: { evidence: args.evidence }),
									...(args.knowledge === undefined
										? {}
										: { knowledge: args.knowledge }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_step: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_journal",
				description:
					"Read the latest journal steps back (bounded by `limit`, optionally narrowed to one session or `app`), with the flow page's file name when there is one.",
				parameters: Type.Object({
					session: SessionParameter,
					app: Type.Optional(
						Type.String({
							description: "Only this application's steps.",
						}),
					),
					limit: Type.Optional(
						Type.Number({
							description: "How many of the newest steps to return (1–200).",
						}),
					),
				}),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_journal: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_JOURNAL_PATH, {
								timeoutMs: JOURNAL_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.app === undefined ? {} : { app: args.app }),
									...(args.limit === undefined ? {} : { limit: args.limit }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_journal: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_eval",
				description:
					"Evaluate JavaScript in the session's page and return the resolved value. Bounded by `timeoutMs`; the session stays usable afterwards.",
				parameters: BrowserEvalParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_eval: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_EVAL_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									code: args.code,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.timeoutMs === undefined
										? {}
										: { timeoutMs: args.timeoutMs }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_eval: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_console",
				description:
					"Read this session's console and page-error history (bounded ring buffer), optionally filtered by `level` and `url`.",
				parameters: BrowserLogParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_console: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_CONSOLE_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: logBody(args),
							}),
						);
					} catch (error) {
						return failure(`browser_console: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_network",
				description:
					"Read this session's request history (bounded ring buffer) with method, URL, resource type, status and failure, optionally filtered by `status` and `url`.",
				parameters: BrowserLogParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_network: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_NETWORK_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: logBody(args),
							}),
						);
					} catch (error) {
						return failure(`browser_network: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_screenshot",
				description: [
					"Capture the session's page (or one element, by ref or selector) as a JPEG and return it to you as an image.",
					"`evidence: true` also stores it in this workflow's evidence store under `caption`, so the developer can review it; without it, only you see the image.",
					"`view: false` (with `evidence: true`) stores it without returning the image, which is how a long flow test documents its steps without filling your context with pictures.",
				].join(" "),
				parameters: BrowserScreenshotParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("browser_screenshot: run context unavailable");
					try {
						const value = (await call(
							run.env,
							"POST",
							AGENT_BROWSER_SCREENSHOT_PATH,
							{
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.ref === undefined ? {} : { ref: args.ref }),
									...(args.selector === undefined
										? {}
										: { selector: args.selector }),
									...(args.fullPage === undefined
										? {}
										: { fullPage: args.fullPage }),
									...(args.evidence === undefined
										? {}
										: { evidence: args.evidence }),
									...(args.view === undefined ? {} : { view: args.view }),
									...(args.caption === undefined
										? {}
										: { caption: args.caption }),
								},
							},
						)) as {
							url?: string;
							mediaType?: string;
							base64?: string;
							evidence?: { id?: string; caption?: string };
						};
						// The caption comes back with the id: a `view: false` call answers
						// without the image, so the caption is the one thing that tells the
						// model which of its steps the stored screenshot belongs to (and it is
						// what the developer reads in the Evidence panel).
						const caption = value.evidence?.caption?.trim();
						const note = value.evidence?.id
							? `\nstored as evidence ${value.evidence.id}${caption === undefined || caption === "" ? "" : ` — ${caption}`}`
							: "\nstored as evidence: no (pass evidence: true to keep it)";
						const summary = `screenshot of ${value.url ?? "the page"}${note}`;
						// `view: false` answers with the evidence id alone, so no image block
						// is built for a picture this call deliberately did not look at.
						return value.base64 === undefined
							? { content: [{ type: "text", text: summary }] }
							: {
									content: [
										{ type: "text", text: summary },
										{
											type: "image",
											data: value.base64,
											mimeType: value.mediaType ?? "image/jpeg",
										},
									],
								};
					} catch (error) {
						return failure(`browser_screenshot: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_record_start",
				description:
					"Start recording a video of this session. It inherits the live page: cookies and storage carry over and the current URL is re-opened. A recording is capped at 10 minutes, then closed without being kept.",
				parameters: BrowserRecordParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("browser_record_start: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_RECORD_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									action: "start",
									...(args.session === undefined
										? {}
										: { session: args.session }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_record_start: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_record_stop",
				description:
					"Stop the recording. `keep: true` stores the WebM and its final-frame poster as evidence under `caption`; `keep: false` (the default) deletes both, leaving no file and no evidence entry.",
				parameters: BrowserRecordParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("browser_record_stop: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_RECORD_PATH, {
								timeoutMs: RECORDING_TIMEOUT_MS,
								body: {
									action: "stop",
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.keep === undefined ? {} : { keep: args.keep }),
									...(args.caption === undefined
										? {}
										: { caption: args.caption }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_record_stop: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_run_script",
				description: [
					"Run Playwright JavaScript against this session's page with `(page, context, expect)`, bounded by `timeoutMs` (default 60s, max 10min).",
					"On timeout the tool fails with `script-timeout` and the session stays usable.",
					"`save: true` stores the code as a rerunnable `@playwright/test` spec (with the page URL pinned) in this workflow's evidence.",
					// The facade is an allow-list: naming it here is what keeps an agent from
					// discovering the surface by failing (`fix-env-tool-defects-from-e2e`).
					"`page` supports: goto, reload, goBack, goForward, url, title, content (truncated), setViewportSize, viewportSize, waitForLoadState, waitForURL, waitForSelector, waitForFunction, waitForTimeout, click, fill, press, selectOption, hover, textContent, innerText, inputValue, isVisible, isEnabled, screenshot, evaluate, locator, getByRole, getByText, getByLabel, getByPlaceholder, getByTestId, getByTitle, getByAltText, context(), keyboard, mouse.",
					"`context` supports: newPage, pages, cookies, addCookies, clearCookies, storageState, setDefaultTimeout, setDefaultNavigationTimeout, waitForTimeout; a locator supports the usual click/fill/press/waitFor/count/text reads and nested locator/getBy* builders.",
					"The handles are an allow-list facade, not a sandbox: a method outside the lists throws with the supported names in its message, and a result that would walk back to the shared browser (a `Response`, a `JSHandle`, another session's context) is refused.",
				].join(" "),
				parameters: BrowserScriptParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("browser_run_script: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_SCRIPT_PATH, {
								timeoutMs: RECORDING_TIMEOUT_MS,
								body: {
									code: args.code,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.save === undefined ? {} : { save: args.save }),
									...(args.caption === undefined
										? {}
										: { caption: args.caption }),
									...(args.timeoutMs === undefined
										? {}
										: { timeoutMs: args.timeoutMs }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_run_script: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_close",
				description:
					"Close one session and release its slot to whoever is waiting. Do this when you are done browsing: another workflow may be waiting for the session cap.",
				parameters: BrowserSessionParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_close: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_CLOSE_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_close: ${message(error)}`);
					}
				},
			}),
		],
	});
}

/** The shared filter body of the two log reads. */
function logBody(args: {
	readonly session?: string;
	readonly level?: string;
	readonly status?: number;
	readonly url?: string;
	readonly limit?: number;
}): Record<string, unknown> {
	return {
		...(args.session === undefined ? {} : { session: args.session }),
		...(args.level === undefined ? {} : { level: args.level }),
		...(args.status === undefined ? {} : { status: args.status }),
		...(args.url === undefined ? {} : { url: args.url }),
		...(args.limit === undefined ? {} : { limit: args.limit }),
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
