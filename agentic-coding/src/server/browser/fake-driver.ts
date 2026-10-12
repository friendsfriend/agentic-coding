// A deterministic in-memory driver (`add-agent-browser-sessions`, task 3.1's
// "verify with a fake browser driver").
//
// It implements exactly the boundary the pool and the tools are built against,
// so pool lifecycle (cap, FIFO, idle TTL, crash, recording), the ref contract
// and the tool pipeline are all exercised without a Chromium download. Nothing
// here is a Playwright emulation: it is a browser that answers the calls the
// server makes, and records them.
import type {
	BrowserDriver,
	DriverBrowser,
	DriverConsoleEntry,
	DriverContext,
	DriverContextOptions,
	DriverNetworkEvent,
	DriverPage,
	DriverScreenshotOptions,
} from "./types.ts";

/** A stand-in for Playwright's `Response`: a class instance, not plain data, so
 * the script facade's deny-by-default refusal applies to it exactly as it does to
 * the real one. */
class FakeNavigationResponse {
	constructor(private readonly page: object) {}

	status(): number {
		return 200;
	}

	frame(): { page: () => object } {
		return { page: () => this.page };
	}
}

export interface FakeDriverOptions {
	/** Fail every launch with this error (an unavailable browser). */
	readonly launchError?: Error;
	/** The snapshot text `snapshot()` returns. Its `[ref=eN]` markers are the
	 * refs the fake accepts, exactly like a real page's injected attributes. */
	readonly snapshot?: string;
	/** The bytes every screenshot resolves to. */
	readonly screenshot?: Uint8Array;
	/** The bytes a kept recording writes. */
	readonly video?: string | Uint8Array;
}

export interface FakeContext extends DriverContext {
	readonly recorded: boolean;
}

export interface FakePage extends DriverPage {
	/** Every selector an action was performed on, in order. */
	readonly performed: string[];
	/** The live viewport, so a narrowed capture is observable. */
	viewport: { width: number; height: number };
	/** The viewport each capture ran at, so a bounded screenshot is assertable. */
	readonly capturedAt: Array<{ width: number; height: number }>;
	emitConsole(entry: DriverConsoleEntry): void;
	emitNetwork(event: DriverNetworkEvent): void;
	close(): void;
}

export interface FakeDriver extends BrowserDriver {
	launches: number;
	contexts: number;
	readonly pages: FakePage[];
	/** Every selector the driver was asked to act on, across pages. */
	readonly performed: string[];
	/** Simulate the browser process going away. */
	crash(): void;
	/** Make every navigation fail, as an app that is not up yet does. */
	failGoto: boolean;
	/** Make exactly the next navigation fail, and no other. */
	failNextGoto: boolean;
	/** Hold every navigation until released, so a first navigation can be observed
	 * as work in flight. */
	holdGoto: boolean;
	releaseGoto(): void;
	/** Hold every `newContext` until released, so an in-flight recording swap can
	 * be observed from another session. */
	holdNewContext: boolean;
	/** Release the contexts `holdNewContext` is holding. */
	releaseNewContext(): void;
	lastPage(): FakePage | undefined;
}

const DEFAULT_SNAPSHOT = [
	"- url: about:blank",
	"- title: Fake",
	'button "Save" [ref=e0]',
	'textbox "Name" [ref=e1]',
	'link "Home" [ref=e2]',
].join("\n");

export function createFakeDriver(options: FakeDriverOptions = {}): FakeDriver {
	const pages: FakePage[] = [];
	const performed: string[] = [];
	const snapshotText = options.snapshot ?? DEFAULT_SNAPSHOT;
	const screenshotBytes =
		options.screenshot ??
		new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]);
	const videoBytes = options.video ?? "fake-webm";
	let launchCount = 0;
	let contextCount = 0;
	let failGoto = false;
	let failNextGoto = false;
	let holdingGoto = false;
	const heldGotos: Array<() => void> = [];
	let holding = false;
	const held: Array<() => void> = [];
	let disconnected: (() => void) | undefined;
	let connected = false;

	const makePage = (context: { url: string; recorded: boolean }): FakePage => {
		const consoleListeners: Array<(entry: DriverConsoleEntry) => void> = [];
		const networkListeners: Array<(event: DriverNetworkEvent) => void> = [];
		const closedListeners: Array<() => void> = [];
		const performedHere: string[] = [];
		let sequence = 0;
		// A deliberately leaky stand-in for a real page: it carries the same
		// references a real Playwright page does (`locator` results and the input
		// devices point back at the page), so a facade that fails to mask them is
		// caught here rather than only against a real browser.
		const rawPage: Record<string, unknown> = {
			send: async () => "fake",
			// Enough of a page's shape for the script facade to recognize it.
			goto: async () => null,
			url: () => "about:blank",
			locator: () => ({
				click: async () => {},
				fill: async () => {},
				textContent: async () => "fake",
				page: rawPage,
			}),
		};
		rawPage.keyboard = { press: async () => {}, page: rawPage };
		rawPage.mouse = { click: async () => {}, page: rawPage };
		const page: FakePage = {
			performed: performedHere,
			viewport: { width: 1280, height: 800 },
			capturedAt: [],
			url: () => context.url,
			goto: async (url) => {
				if (holdingGoto)
					await new Promise<void>((resolve) => {
						heldGotos.push(resolve);
					});
				if (failNextGoto) {
					failNextGoto = false;
					throw new Error("net::ERR_CONNECTION_REFUSED");
				}
				if (failGoto) throw new Error("net::ERR_CONNECTION_REFUSED");
				context.url = url;
				const id = `r${++sequence}`;
				for (const listener of networkListeners)
					listener({
						kind: "request",
						id,
						method: "GET",
						url,
						resourceType: "document",
					});
				for (const listener of networkListeners)
					listener({ kind: "response", id, status: 200, ok: true });
				// A real navigation resolves to a `Response`, which carries a path back
				// to the browser (`frame().page().context().browser()`): the script
				// facade must refuse it rather than pass it through. It is a class
				// instance, exactly like the real one, so the refusal is the same.
				return new FakeNavigationResponse(rawPage) as unknown as number;
			},
			title: async () => "Fake",
			content: async () => context.url,
			evaluate: async (expression) =>
				expression.includes("document")
					? context.url
					: `evaluated:${expression}`,
			snapshot: async () => snapshotText,
			setViewportSize: async (size) => {
				page.viewport = { ...size };
			},
			click: async (selector) => {
				performedHere.push(`click:${selector}`);
				performed.push(`click:${selector}`);
				assertKnownRef(selector, snapshotText);
			},
			fill: async (selector, value) => {
				performedHere.push(`fill:${selector}=${value}`);
				performed.push(`fill:${selector}=${value}`);
				assertKnownRef(selector, snapshotText);
			},
			press: async (selector, key) => {
				performedHere.push(`press:${selector}=${key}`);
				performed.push(`press:${selector}=${key}`);
				assertKnownRef(selector, snapshotText);
			},
			selectOption: async (selector, values) => {
				performedHere.push(`select:${selector}=${values.join(",")}`);
				performed.push(`select:${selector}=${values.join(",")}`);
				assertKnownRef(selector, snapshotText);
			},
			hover: async (selector) => {
				performedHere.push(`hover:${selector}`);
				performed.push(`hover:${selector}`);
				assertKnownRef(selector, snapshotText);
			},
			waitForSelector: async (selector) => {
				assertKnownRef(selector, snapshotText);
			},
			waitForText: async () => {},
			waitForUrl: async () => {},
			textContent: async () => "fake text",
			screenshot: async (_options: DriverScreenshotOptions) => {
				page.capturedAt.push({ ...page.viewport });
				return screenshotBytes;
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
			emitConsole: (entry) => {
				for (const listener of consoleListeners) listener(entry);
			},
			emitNetwork: (event) => {
				for (const listener of networkListeners) listener(event);
			},
			close: () => {
				for (const listener of closedListeners) listener();
			},
			raw: () => rawPage,
		};
		pages.push(page);
		return page;
	};

	const newContextWhenAllowed = async (
		options: DriverContextOptions,
	): Promise<FakeContext> => {
		if (holding)
			await new Promise<void>((resolve) => {
				held.push(resolve);
			});
		return makeContext(options);
	};

	const makeContext = (options: DriverContextOptions): FakeContext => {
		contextCount += 1;
		const world = {
			url: "about:blank",
			recorded: options.recordVideo !== undefined,
		};
		const own: FakePage[] = [];
		const context: FakeContext = {
			recorded: world.recorded,
			page: async () => {
				const page = makePage(world);
				own.push(page);
				return page;
			},
			pages: () => own,
			// Closing a context closes its pages, exactly like a real browser: the
			// session's swap guard is what has to tell a replacement from a crash.
			close: async () => {
				for (const page of own) page.close();
			},
			storageState: async () => ({
				cookies: [],
				origins: [
					{
						origin: "http://fake.local",
						localStorage: [{ name: "token", value: "abc" }],
					},
				],
			}),
			video: () =>
				world.recorded
					? {
							saveAs: async (file: string) => {
								await Bun.write(file, videoBytes);
							},
						}
					: undefined,
			// The same leaky shape a real context has: `newPage`/`pages` hand back
			// raw pages (the page adapters' own raw objects), which the script
			// facade must mask.
			raw: () =>
				({
					fakeContext: true,
					newPage: async () => (own[0] ?? (await context.page())).raw(),
					pages: () => own.map((entry) => entry.raw()),
				}) as object,
		};
		return context;
	};

	return {
		pages,
		performed,
		async launch() {
			if (options.launchError) throw options.launchError;
			launchCount += 1;
			connected = true;
			const browser: DriverBrowser = {
				newContext: async (contextOptions) =>
					await newContextWhenAllowed(contextOptions),
				close: async () => {
					connected = false;
				},
				isConnected: () => connected,
				onDisconnected: (listener) => {
					disconnected = listener;
				},
			};
			return browser;
		},
		get launches() {
			return launchCount;
		},
		get contexts() {
			return contextCount;
		},
		get failGoto() {
			return failGoto;
		},
		set failGoto(value: boolean) {
			failGoto = value;
		},
		get failNextGoto() {
			return failNextGoto;
		},
		set failNextGoto(value: boolean) {
			failNextGoto = value;
		},
		get holdGoto() {
			return holdingGoto;
		},
		set holdGoto(value: boolean) {
			holdingGoto = value;
		},
		releaseGoto() {
			holdingGoto = false;
			const waiting = heldGotos.splice(0, heldGotos.length);
			for (const resolve of waiting) resolve();
		},
		get holdNewContext() {
			return holding;
		},
		set holdNewContext(value: boolean) {
			holding = value;
		},
		releaseNewContext() {
			holding = false;
			const waiting = held.splice(0, held.length);
			for (const resolve of waiting) resolve();
		},
		crash() {
			connected = false;
			disconnected?.();
			for (const page of pages) page.close();
		},
		lastPage: () => pages[pages.length - 1],
	};
}

/** The fake's ref contract: a `data-ac-ref` selector must name a ref the
 * snapshot produced, exactly like a real page that injected the attributes. */
function assertKnownRef(selector: string, snapshot: string): void {
	const match = selector.match(/^\[data-ac-ref="(e\d+)"\]$/);
	if (!match) return;
	const ref = match[1];
	if (ref === undefined || !snapshot.includes(`[ref=${ref}]`))
		throw new Error(`unknown ref ${ref}`);
}
