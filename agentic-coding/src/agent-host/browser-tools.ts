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
	AGENT_BROWSER_NETWORK_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SCRIPT_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
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
const NAVIGATION_TIMEOUT_MS = 120_000;
const RECORDING_TIMEOUT_MS = 180_000;

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
			description: "The URL to open. Any URL is allowed.",
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
	caption: Type.Optional(
		Type.String({
			description:
				"One line the developer reads next to the evidence, saying what it shows.",
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
				"Fill an input named by a ref from the latest browser_snapshot (preferred) or a selector with `value`.",
				{
					value: Type.String({
						description: "The text to type into the field.",
					}),
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
									...(args.caption === undefined
										? {}
										: { caption: args.caption }),
								},
							},
						)) as {
							url?: string;
							mediaType?: string;
							base64: string;
							evidence?: { id?: string };
						};
						const note = value.evidence?.id
							? `\nstored as evidence ${value.evidence.id}`
							: "\nstored as evidence: no (pass evidence: true to keep it)";
						return {
							content: [
								{
									type: "text",
									text: `screenshot of ${value.url ?? "the page"}${note}`,
								},
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
