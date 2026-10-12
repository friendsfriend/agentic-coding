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
import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import { SNAPSHOT_SCRIPT } from "./snapshot.ts";
import type {
	BrowserDriver,
	DriverBrowser,
	DriverConsoleEntry,
	DriverContext,
	DriverLaunchOptions,
	DriverNetworkEvent,
	DriverPage,
	DriverScreenshotOptions,
} from "./types.ts";

/** One page, adapted once: the page's listeners are registered a single time
 * however many times the adapter is asked for it. */
const pageAdapters = new WeakMap<Page, DriverPage>();

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
			});
			return adaptContext(context);
		},
	};
}

function adaptContext(context: BrowserContext): DriverContext {
	return {
		page: async () => adaptPage(await firstPage(context)),
		pages: () => context.pages().map((page) => adaptPage(page)),
		close: async () => {
			await context.close();
		},
		storageState: () => context.storageState(),
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
	const closedListeners: Array<() => void> = [];
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
		for (const listener of closedListeners) listener();
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
			if (options.selector !== undefined) {
				const element = await page
					.locator(options.selector)
					.first()
					.screenshot({ type: options.type, ...quality });
				return new Uint8Array(element);
			}
			const view = await page.screenshot({
				type: options.type,
				...quality,
				fullPage: options.fullPage,
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
