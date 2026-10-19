// The Playwright implementation of the driver boundary
// (`add-agent-browser-sessions`).
//
// This is the only module that imports Playwright. It adapts the real objects
// to the narrow `driver.ts` surface, so:
//
// * the pool and the tools never see a Playwright type and a fake driver
//   exercises the same pipeline (`fake-driver.ts`),
// * Playwright is loaded lazily (`await import`), so a server that never opens a
//   browser never pays for the module,
// * the injected snapshot attributes (`snapshot.ts`) and the element actions both
//   go through one locator policy — `locator(selector).first()` — so a ref that
//   matches one element cannot fail with Playwright's strict-mode error.
import type {
	Browser,
	BrowserContext,
	Locator,
	Page,
	Request,
} from "playwright-core";
import { bannerRemovalScript } from "./banner.ts";
import { SNAPSHOT_SCRIPT } from "./snapshot.ts";
import type {
	BrowserDriver,
	DriverAuthorizationProvider,
	DriverBrowser,
	DriverConsoleEntry,
	DriverContext,
	DriverCookie,
	DriverHttpCredentials,
	DriverLaunchOptions,
	DriverLocator,
	DriverNetworkEvent,
	DriverPage,
	DriverPageCloseReason,
	DriverRequestInfo,
	DriverScreenshotOptions,
} from "./types.ts";

/** One page, adapted once: the page's listeners are registered a single time
 * however many times the adapter is asked for it. */
const pageAdapters = new WeakMap<Page, DriverPage>();

/** The contexts this server has asked to close. A page's `close` event fires
 * for both a window the developer closed and a context the pool dropped, and
 * this is the only place that knows which one happened: the close is a *server*
 * close when the context it belongs to was closed through this adapter, and the
 * developer's own window close otherwise. */
const serverClosedContexts = new WeakSet<BrowserContext>();

export function createPlaywrightDriver(): BrowserDriver {
	return {
		async launch(options: DriverLaunchOptions): Promise<DriverBrowser> {
			if (!options.executablePath && !options.channel)
				throw new Error("no browser executable was resolved");
			const { chromium } = await import("playwright-core");
			const browser = await chromium.launch({
				headless: options.headless,
				...(options.executablePath
					? { executablePath: options.executablePath }
					: {}),
				...(options.channel ? { channel: options.channel } : {}),
			});
			return adaptBrowser(browser);
		},
	};
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

function adaptBrowser(browser: Browser): DriverBrowser {
	return {
		isConnected: () => browser.isConnected(),
		onDisconnected: (listener) => {
			browser.on("disconnected", listener);
		},
		close: () => browser.close(),
		newContext: async (options) => {
			const context = await browser.newContext({
				viewport: options.viewport,
				...(options.recordVideo
					? {
							recordVideo: {
								dir: options.recordVideo.dir,
								size: options.recordVideo.size,
							},
						}
					: {}),
				...(options.storageState === undefined
					? {}
					: { storageState: options.storageState as StorageState }),
				...(options.httpCredentials === undefined
					? {}
					: { httpCredentials: options.httpCredentials }),
			});
			// The stage guard lives on the context, so a recording's replacement
			// context carries it too: the pool passes the same guard again rather than
			// the guard being re-derived from the session. The bearer authorization is
			// installed on the same route handler, so one rule decides one request.
			if (options.guard || options.authorization)
				await routeThroughGuard(context, options.guard, options.authorization);
			return adaptContext(context);
		},
	};
}

/** One request, as the guard needs to see it. `frame()` throws for a request
 * that has no frame (a service worker), which is never a main-frame navigation. */
function requestInfo(request: Request): DriverRequestInfo {
	let isMainFrameNavigation = false;
	let initiator: string | undefined;
	try {
		const frame = request.frame();
		isMainFrameNavigation =
			request.isNavigationRequest() && frame.parentFrame() === null;
		// The document that issued the request: the one fact a bearer provider
		// cannot read from the target URL (SEC-002).
		initiator = frame.url();
	} catch {
		isMainFrameNavigation = false;
		initiator = undefined;
	}
	return {
		url: request.url(),
		method: request.method(),
		resourceType: request.resourceType(),
		isMainFrameNavigation,
		...(initiator === undefined ? {} : { initiator }),
	};
}

/** Install one guard (and one bearer provider) on one context: every request the
 * guard refuses is aborted, every request the provider can authenticate is
 * continued with the `Authorization` header it answers. */
async function routeThroughGuard(
	context: BrowserContext,
	guard: ((request: DriverRequestInfo) => boolean) | undefined,
	authorization: DriverAuthorizationProvider | undefined,
): Promise<void> {
	await context.route("**/*", async (route) => {
		const request = route.request();
		const info = requestInfo(request);
		if (guard !== undefined && !guard(info)) {
			// A race the page itself caused (a navigation the page already replaced) is
			// not a guard failure: the request is gone either way.
			await route.abort().catch(() => {});
			return;
		}
		if (authorization === undefined) {
			await route.continue().catch(() => {});
			return;
		}
		let header: string | undefined;
		try {
			const headers = await request.allHeaders();
			// A request that already carries a credential keeps its own: the page's own
			// session wins, and a second header on top of it would be a token the stage
			// never asked for.
			if (headers.authorization === undefined)
				header = await authorization(info);
			if (header === undefined) {
				await route.continue().catch(() => {});
				return;
			}
			await route
				.continue({ headers: { ...headers, authorization: header } })
				.catch(() => {});
		} catch {
			// A provider that failed, or a request that vanished: the request is
			// continued as the page wrote it. Never aborted — an unauthenticated page is
			// a usable page, and an abort would look like a broken application.
			await route.continue().catch(() => {});
		}
	});
}

/** The one place a locator descriptor becomes a Playwright locator, so a login
 * recipe works across pages and a mask covers exactly what a recipe filled. */
function locatorOf(page: Page, locator: DriverLocator): Locator {
	if (locator.selector !== undefined && locator.selector !== "")
		return page.locator(locator.selector);
	if (locator.label !== undefined && locator.label !== "")
		return page.getByLabel(locator.label);
	if (locator.role !== undefined && locator.role !== "") {
		const role = locator.role as Parameters<Page["getByRole"]>[0];
		return locator.name === undefined
			? page.getByRole(role)
			: page.getByRole(role, { name: locator.name });
	}
	throw new Error(
		"a locator needs a selector, a label, or a role (with a name)",
	);
}

function adaptContext(context: BrowserContext): DriverContext {
	return {
		page: async () => adaptPage(await firstPage(context)),
		pages: () => context.pages().map((page) => adaptPage(page)),
		close: async () => {
			serverClosedContexts.add(context);
			await context.close();
		},
		addInitScript: async (script: string) => {
			// A context-level script, so the banner is installed on every document of
			// the session, including the IdP redirect that performs the login.
			await context.addInitScript({ content: script });
		},
		storageState: () => context.storageState(),
		// A cached identity is installed as cookies before the first navigation, so
		// the identity provider sees its own sign-on cookie on the very first
		// request instead of after a login round trip
		// (`add-stage-identity-cache`, D3). Playwright takes back exactly the cookie
		// shape `storageState()` reported, so nothing in the capture is lost here.
		addCookies: async (cookies: readonly DriverCookie[]) => {
			if (cookies.length === 0) return;
			await context.addCookies(
				cookies.map((cookie) => ({
					name: cookie.name,
					value: cookie.value,
					domain: cookie.domain,
					path: cookie.path,
					expires: cookie.expires,
					httpOnly: cookie.httpOnly,
					secure: cookie.secure,
					...(cookie.sameSite === undefined
						? {}
						: { sameSite: cookie.sameSite }),
				})),
			);
		},
		setHttpCredentials: async (credentials: DriverHttpCredentials) => {
			await context.setHTTPCredentials(credentials);
		},
		video: () => {
			// The video belongs to the page that recorded it; Playwright exposes it
			// only through `page.video()`. The handle is taken now and saved later,
			// after the context closes and the file is complete.
			const recording = context.pages()[0]?.video();
			if (!recording) return undefined;
			return { saveAs: async (path) => recording.saveAs(path) };
		},
		raw: () => context,
	};
}

async function firstPage(context: BrowserContext): Promise<Page> {
	const existing = context.pages()[0];
	return existing ?? (await context.newPage());
}

function adaptPage(page: Page): DriverPage {
	const cached = pageAdapters.get(page);
	if (cached) return cached;
	const consoleListeners: Array<(entry: DriverConsoleEntry) => void> = [];
	const networkListeners: Array<(event: DriverNetworkEvent) => void> = [];
	const closedListeners: Array<(reason: DriverPageCloseReason) => void> = [];
	const requestIds = new WeakMap<Request, string>();
	let sequence = 0;
	const emitNetwork = (event: DriverNetworkEvent) => {
		for (const listener of networkListeners) listener(event);
	};
	page.on("console", (message) => {
		const location = message.location();
		const entry: DriverConsoleEntry = {
			type: message.type(),
			text: message.text(),
			...(location?.url
				? { location: `${location.url}:${location.lineNumber}` }
				: {}),
		};
		for (const listener of consoleListeners) listener(entry);
	});
	page.on("pageerror", (error) => {
		const entry: DriverConsoleEntry = { type: "error", text: error.message };
		for (const listener of consoleListeners) listener(entry);
	});
	page.on("request", (request) => {
		const id = `r${++sequence}`;
		requestIds.set(request, id);
		emitNetwork({
			kind: "request",
			id,
			method: request.method(),
			url: request.url(),
			resourceType: request.resourceType(),
			// Presence only: the value never enters a network event, so no console or
			// `browser_network` line can carry a token (`add-stage-oauth2-auth`, 2.3).
			hasAuthorization: request.headers().authorization !== undefined,
		});
	});
	page.on("response", (response) => {
		const id = requestIds.get(response.request());
		if (!id) return;
		emitNetwork({
			kind: "response",
			id,
			status: response.status(),
			ok: response.ok(),
		});
	});
	page.on("requestfailed", (request) => {
		const id = requestIds.get(request);
		if (!id) return;
		emitNetwork({
			kind: "failed",
			id,
			error: request.failure()?.errorText ?? "the request failed",
		});
	});
	page.on("close", () => {
		const reason: DriverPageCloseReason = serverClosedContexts.has(
			page.context(),
		)
			? "server"
			: "user";
		for (const listener of closedListeners) listener(reason);
	});
	const adapter: DriverPage = {
		url: () => page.url(),
		goto: async (url, timeoutMs) => {
			const response = await page.goto(url, {
				timeout: timeoutMs,
				waitUntil: "domcontentloaded",
			});
			return response ? response.status() : null;
		},
		title: () => page.title(),
		content: () => page.content(),
		// A string expression, not a closure: the injected script must survive the
		// boundary as text, and Playwright evaluates a string as an expression.
		evaluate: (expression) =>
			page.evaluate(expression as unknown as () => unknown),
		snapshot: async () => {
			const value = await page.evaluate(
				SNAPSHOT_SCRIPT as unknown as () => unknown,
			);
			return typeof value === "string" ? value : JSON.stringify(value);
		},
		setViewportSize: (size) => page.setViewportSize(size),
		bringToFront: async () => {
			await page.bringToFront();
		},
		removeBanner: async () => {
			// An installed init script cannot be uninstalled, so ending a hand-off
			// removes the banner from the documents that are already open.
			await page
				.evaluate(bannerRemovalScript() as unknown as () => unknown)
				.catch(() => {});
		},
		click: async (selector, timeoutMs) => {
			await page.locator(selector).first().click({ timeout: timeoutMs });
		},
		fill: async (selector, value, timeoutMs) => {
			await page.locator(selector).first().fill(value, { timeout: timeoutMs });
		},
		press: async (selector, key, timeoutMs) => {
			await page.locator(selector).first().press(key, { timeout: timeoutMs });
		},
		selectOption: async (selector, values, timeoutMs) => {
			await page
				.locator(selector)
				.first()
				.selectOption([...values], { timeout: timeoutMs });
		},
		hover: async (selector, timeoutMs) => {
			await page.locator(selector).first().hover({ timeout: timeoutMs });
		},
		fillField: async (locator, value, timeoutMs) => {
			await locatorOf(page, locator)
				.first()
				.fill(value, { timeout: timeoutMs });
		},
		clickControl: async (locator, timeoutMs) => {
			await locatorOf(page, locator).first().click({ timeout: timeoutMs });
		},
		waitForControl: async (locator, timeoutMs) => {
			await locatorOf(page, locator)
				.first()
				.waitFor({ state: "visible", timeout: timeoutMs });
		},
		locatorCount: async (locator) => await locatorOf(page, locator).count(),
		waitForSelector: async (selector, timeoutMs) => {
			await page
				.locator(selector)
				.first()
				.waitFor({ state: "visible", timeout: timeoutMs });
		},
		waitForText: async (text, timeoutMs) => {
			await page
				.getByText(text)
				.first()
				.waitFor({ state: "visible", timeout: timeoutMs });
		},
		waitForUrl: async (pattern, timeoutMs) => {
			await page.waitForURL(pattern, { timeout: timeoutMs });
		},
		textContent: async (selector, timeoutMs) => {
			const value = await page
				.locator(selector)
				.first()
				.textContent({ timeout: timeoutMs });
			return value ?? "";
		},
		screenshot: async (options: DriverScreenshotOptions) => {
			const quality =
				options.quality === undefined ? {} : { quality: options.quality };
			const mask = (options.mask ?? []).map((locator) =>
				locatorOf(page, locator),
			);
			const masked = mask.length === 0 ? {} : { mask };
			if (options.selector !== undefined) {
				const element = await page
					.locator(options.selector)
					.first()
					.screenshot({ type: options.type, ...quality, ...masked });
				return new Uint8Array(element);
			}
			const view = await page.screenshot({
				type: options.type,
				...quality,
				fullPage: options.fullPage,
				...masked,
			});
			return new Uint8Array(view);
		},
		onConsole: (listener) => {
			consoleListeners.push(listener);
		},
		onNetwork: (listener) => {
			networkListeners.push(listener);
		},
		onClosed: (listener) => {
			closedListeners.push(listener);
		},
		raw: () => page,
	};
	pageAdapters.set(page, adapter);
	return adapter;
}
