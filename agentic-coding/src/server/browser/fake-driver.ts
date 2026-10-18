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
	DriverHttpCredentials,
	DriverLocator,
	DriverNetworkEvent,
	DriverPage,
	DriverRequestGuard,
	DriverRequestInfo,
	DriverScreenshotOptions,
} from "./types.ts";
import { driverLocatorKey } from "./types.ts";

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
	/** The HTML `content()` returns, so the script facade's own bound on it is
	 * observable with a page bigger than the bound. */
	readonly content?: string;
	/** Fail every fill the way a real driver does when the element is present but
	 * not editable: the value is inside the error's own call log, which is exactly
	 * the shape a credential must never let through. */
	readonly failFill?: boolean;
}

/** One fake context's mutable world: the URL it is on, whether it records, the
 * controls a test removed, and the guard it asks before a navigation. */
interface FakeWorld {
	url: string;
	readonly recorded: boolean;
	readonly absent: ReadonlySet<string>;
	readonly counts: ReadonlyMap<string, number>;
	askGuard(info: DriverRequestInfo): boolean;
}

export interface FakeContext extends DriverContext {
	readonly recorded: boolean;
	/** The stage guard this context was created with, if any. */
	readonly guard: DriverRequestGuard | undefined;
	/** Ask the guard about one request, as the routing layer would. */
	runGuard(request: DriverRequestInfo): boolean;
	/** The HTTP credentials installed on this context, if any. */
	httpCredentials: DriverHttpCredentials | undefined;
}

export interface FakePage extends DriverPage {
	/** Every selector an action was performed on, in order. */
	readonly performed: string[];
	/** The live viewport, so a narrowed capture is observable. */
	viewport: { width: number; height: number };
	/** The viewport each capture ran at, so a bounded screenshot is assertable. */
	readonly capturedAt: Array<{ width: number; height: number }>;
	/** The mask each capture was given, so "masking options passed" is
	 * assertable without a real image. */
	readonly masked: Array<readonly DriverLocator[]>;
	emitConsole(entry: DriverConsoleEntry): void;
	emitNetwork(event: DriverNetworkEvent): void;
	close(): void;
}

/** One request a fake page makes while a `goto` is in flight. It is page work by
 * default — that is the distinction the field exists for — so only a test that
 * wants a nested navigation has to say so. */
export type DuringGotoRequest = Omit<
	DriverRequestInfo,
	"isMainFrameNavigation"
> & { readonly isMainFrameNavigation?: boolean };

export interface FakeDriver extends BrowserDriver {
	launches: number;
	contexts: number;
	readonly pages: FakePage[];
	/** Every selector the driver was asked to act on, across pages. */
	readonly performed: string[];
	/** Every request the fake asked a guard about, across contexts. */
	readonly guarded: DriverRequestInfo[];
	/** Controls a login step must treat as absent, by `driverLocatorKey` of the
	 * locator descriptor. */
	absentControls: string[];
	/** `locatorCount` answers, by `driverLocatorKey`. Absent means one. */
	counts: Record<string, number>;
	/** Requests the page makes while a `goto` is still in flight, so a navigation's
	 * own page work can be told apart from the navigation itself. Each one is asked
	 * of the guard as page work unless it says otherwise. */
	duringGoto: DuringGotoRequest[];
	/** Every HTTP credential installation, in order. */
	readonly httpCredentials: DriverHttpCredentials[];
	/** Simulate the browser process going away. */
	crash(): void;
	/** Make every navigation fail, as an app that is not up yet does. */
	failGoto: boolean;
	/** Make exactly the next navigation fail, and no other. */
	failNextGoto: boolean;
	/** Hold every navigation until released, so a first navigation can be observed
	 * as work in flight. */
	holdGoto: boolean;
	/** How many navigations are held right now, so a test can wait for one to be
	 * in flight instead of guessing. */
	readonly pendingGotos: number;
	releaseGoto(): void;
	/** Hold every `newContext` until released, so an in-flight recording swap can
	 * be observed from another session. */
	holdNewContext: boolean;
	/** How many `newContext` calls are held right now, so a test can wait for one
	 * to be in flight instead of guessing. Do not read it as `holdNewContext`. */
	readonly pendingContexts: number;
	/** Release the contexts `holdNewContext` is holding. */
	releaseNewContext(): void;
	/** The status `goto` answers with. Unset, a navigation resolves to a response
	 * object (which the script facade has to refuse); a number is the status a real
	 * browser reports, which is what tells an http-basic login apart from a 401. */
	navigationStatus: number | undefined;
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
	const guarded: DriverRequestInfo[] = [];
	const httpCredentialsCalls: DriverHttpCredentials[] = [];
	let absentControls: string[] = [];
	let counts: Record<string, number> = {};
	/** Requests the page makes while a `goto` is still in flight: the subresources
	 * and beacons of the page the navigation is loading, which reach the guard
	 * before the navigation itself returns. */
	let duringGoto: DuringGotoRequest[] = [];
	const snapshotText = options.snapshot ?? DEFAULT_SNAPSHOT;
	const screenshotBytes =
		options.screenshot ??
		new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]);
	const videoBytes = options.video ?? "fake-webm";
	const failFill = options.failFill ?? false;
	let launchCount = 0;
	let contextCount = 0;
	let failGoto = false;
	let failNextGoto = false;
	let holdingGoto = false;
	const heldGotos: Array<() => void> = [];
	let holding = false;
	const held: Array<() => void> = [];
	let navigationStatusValue: number | undefined;
	let disconnected: (() => void) | undefined;
	let connected = false;

	const makePage = (context: FakeWorld): FakePage => {
		const consoleListeners: Array<(entry: DriverConsoleEntry) => void> = [];
		const networkListeners: Array<(event: DriverNetworkEvent) => void> = [];
		const closedListeners: Array<() => void> = [];
		const performedHere: string[] = [];
		let sequence = 0;
		/** Whether the control a locator names exists, as a page without it
		 * answers: `waitForControl` throws and `locatorCount` answers zero. */
		const hasControl = (locator: DriverLocator): boolean =>
			!context.absent.has(driverLocatorKey(locator));
		const controlCount = (locator: DriverLocator): number => {
			const key = driverLocatorKey(locator);
			return context.counts.get(key) ?? (context.absent.has(key) ? 0 : 1);
		};
		// What the page's inputs hold, by selector: a value typed into a field — by
		// a credential fill or by the script itself — is what reading that field
		// back out returns, exactly like a real page.
		const filledInputs = new Map<string, string>();
		// A deliberately leaky stand-in for a real page: it carries the same
		// references a real Playwright page does (`locator` results and the input
		// devices point back at the page), so a facade that fails to mask them is
		// caught here rather than only against a real browser.
		const rawLocator = (): object => ({
			click: async () => {},
			fill: async () => {},
			textContent: async () => "fake",
			page: rawPage,
		});
		const rawPage: Record<string, unknown> = {
			send: async () => "fake",
			// Enough of a page's shape for the script facade to recognize it, and the
			// methods the facade's own allow-list names, so the surface an agent is
			// told about is the surface the fake exercises. A navigation from the raw
			// page asks the guard exactly like the adapter's does: a real context's
			// route handler sees a navigation whoever started it.
			// The rest of the page loads *during* the navigation, so its own requests
			// ask the guard while the main frame is still in flight.
			goto: async (url: string) => {
				if (
					context.askGuard({
						url,
						method: "GET",
						resourceType: "document",
						isMainFrameNavigation: true,
					}) === false
				)
					throw new Error("net::ERR_ABORTED");
				// The same hold the session's own page applies: a navigation a `goto`
				// started is work in flight whoever asked for it.
				if (holdingGoto)
					await new Promise<void>((resolve) => {
						heldGotos.push(resolve);
					});
				context.url = url;
				return null;
			},
			url: () => "about:blank",
			locator: () => rawLocator(),
			getByRole: () => rawLocator(),
			getByText: () => rawLocator(),
			getByLabel: () => rawLocator(),
			getByPlaceholder: () => rawLocator(),
			getByTestId: () => rawLocator(),
			getByTitle: () => rawLocator(),
			getByAltText: () => rawLocator(),
			title: async () => "Fake",
			content: async () => options.content ?? "<html>fake</html>",
			setViewportSize: async (size: { width: number; height: number }) => {
				page.viewport = { ...size };
			},
			viewportSize: () => ({ ...page.viewport }),
			waitForLoadState: async () => {},
			waitForURL: async () => {},
			waitForSelector: async () => {},
			waitForFunction: async () => {},
			waitForTimeout: async () => {},
			click: async () => {},
			fill: async (selector: string, value: string) => {
				filledInputs.set(selector, value);
			},
			press: async () => {},
			selectOption: async () => {},
			hover: async () => {},
			textContent: async () => "fake text",
			innerText: async () => "fake text",
			inputValue: async (selector: string) => filledInputs.get(selector) ?? "",
			isVisible: async () => true,
			isEnabled: async () => true,
			// A real page exposes `screenshot` to whoever holds it, so the *raw* page
			// does too: a facade that fails to carry the session's mask is then caught
			// here rather than by the method being missing.
			screenshot: async (options: DriverScreenshotOptions) => {
				page.capturedAt.push({ ...page.viewport });
				page.masked.push(options.mask ?? []);
				return screenshotBytes;
			},
			evaluate: async () => "evaluated",
		};
		rawPage.keyboard = { press: async () => {}, page: rawPage };
		rawPage.mouse = { click: async () => {}, page: rawPage };
		const page: FakePage = {
			performed: performedHere,
			viewport: { width: 1280, height: 800 },
			capturedAt: [],
			masked: [],
			url: () => context.url,
			goto: async (url) => {
				if (
					context.askGuard({
						url,
						method: "GET",
						resourceType: "document",
						isMainFrameNavigation: true,
					}) === false
				)
					throw new Error("net::ERR_ABORTED");
				// The page the navigation loads asks the guard for its own requests while
				// the main frame is still in flight, which is what makes a navigation's
				// *page work* separable from the navigation itself.
				for (const extra of duringGoto)
					context.askGuard({
						...extra,
						isMainFrameNavigation: extra.isMainFrameNavigation ?? false,
					});
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
				return navigationStatusValue === undefined
					? (new FakeNavigationResponse(rawPage) as unknown as number)
					: navigationStatusValue;
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
				filledInputs.set(selector, value);
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
			fillField: async (locator, value) => {
				const key = driverLocatorKey(locator);
				// The field now holds what was typed into it, whatever named it.
				if (locator.selector !== undefined)
					filledInputs.set(locator.selector, value);
				performedHere.push(`fillField:${key}=${value}`);
				performed.push(`fillField:${key}=${value}`);
				if (failFill)
					throw new Error(
						`locator.fill: Timeout 30000ms exceeded. Call log:\n  - fill("${value}")\n  - element is not visible`,
					);
				if (!hasControl(locator)) throw new Error(`no element matches ${key}`);
			},
			clickControl: async (locator) => {
				const key = driverLocatorKey(locator);
				performedHere.push(`clickControl:${key}`);
				performed.push(`clickControl:${key}`);
				if (!hasControl(locator)) throw new Error(`no element matches ${key}`);
			},
			waitForControl: async (locator) => {
				if (!hasControl(locator))
					throw new Error(`no element matches ${driverLocatorKey(locator)}`);
			},
			locatorCount: async (locator) => controlCount(locator),
			waitForSelector: async (selector) => {
				assertKnownRef(selector, snapshotText);
			},
			waitForText: async () => {},
			waitForUrl: async () => {},
			textContent: async () => "fake text",
			screenshot: async (_options: DriverScreenshotOptions) => {
				page.capturedAt.push({ ...page.viewport });
				page.masked.push(_options.mask ?? []);
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
		const world: FakeWorld = {
			url: "about:blank",
			recorded: options.recordVideo !== undefined,
			absent: new Set(absentControls),
			counts: new Map(Object.entries(counts)),
			askGuard: (info) => {
				if (!options.guard) return true;
				guarded.push(info);
				return options.guard(info);
			},
		};
		const own: FakePage[] = [];
		const context: FakeContext = {
			recorded: world.recorded,
			guard: options.guard,
			runGuard: (info) => world.askGuard(info),
			httpCredentials: options.httpCredentials,
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
			setHttpCredentials: async (credentials) => {
				context.httpCredentials = credentials;
				httpCredentialsCalls.push(credentials);
			},
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
		get guarded() {
			return guarded;
		},
		get absentControls() {
			return absentControls;
		},
		set absentControls(value: string[]) {
			absentControls = value;
		},
		get counts() {
			return counts;
		},
		set counts(value: Record<string, number>) {
			counts = value;
		},
		get httpCredentials() {
			return httpCredentialsCalls;
		},
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
		get pendingGotos() {
			return heldGotos.length;
		},
		get duringGoto() {
			return duringGoto;
		},
		set duringGoto(value: DuringGotoRequest[]) {
			duringGoto = value;
		},
		get navigationStatus() {
			return navigationStatusValue;
		},
		set navigationStatus(value: number | undefined) {
			navigationStatusValue = value;
		},
		get holdNewContext() {
			return holding;
		},
		set holdNewContext(value: boolean) {
			holding = value;
		},
		get pendingContexts() {
			return held.length;
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
