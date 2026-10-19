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
	DriverAuthorizationProvider,
	DriverBrowser,
	DriverConsoleEntry,
	DriverContext,
	DriverContextOptions,
	DriverHttpCredentials,
	DriverLaunchOptions,
	DriverLocator,
	DriverNetworkEvent,
	DriverPage,
	DriverPageCloseReason,
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
/** One launched browser: the headless slot or the interactive one. */
interface FakeBrowserSlot {
	readonly headless: boolean | undefined;
	connected: boolean;
	disconnected?: () => void;
}

interface FakeWorld {
	url: string;
	readonly recorded: boolean;
	readonly absent: ReadonlySet<string>;
	readonly counts: ReadonlyMap<string, number>;
	/** The init scripts installed on this context, so a page created after the
	 * install (and a page that already existed) both report the banner. */
	readonly scripts: string[];
	askGuard(info: DriverRequestInfo): boolean;
	/** The bearer header this context's routing layer would add to one request,
	 * asked exactly the way the real driver asks it (`add-stage-oauth2-auth`,
	 * 3.3): never for a request that already carries an `Authorization` header,
	 * and never when the provider fails. */
	askAuthorization(
		info: DriverRequestInfo,
		headers: Record<string, string>,
	): Promise<string | undefined>;
	/** The browser slot this context and its pages belong to. */
	readonly slot: FakeBrowserSlot;
}

/** The marker that tells a hand-off banner script apart from any other init
 * script, so the fake records *banner* state rather than "a script exists". */
const BANNER_MARKER = "data-ac-handoff-banner";

export interface FakeContext extends DriverContext {
	readonly recorded: boolean;
	/** The stage guard this context was created with, if any. */
	readonly guard: DriverRequestGuard | undefined;
	/** The init scripts installed on this context, in order. */
	readonly initScripts: string[];
	/** Ask the guard about one request, as the routing layer would. */
	runGuard(request: DriverRequestInfo): boolean;
	/** The bearer provider this context was created with, if any. */
	readonly authorization: DriverAuthorizationProvider | undefined;
	/** Ask the bearer provider about one request, as the routing layer would. */
	runAuthorization(
		request: DriverRequestInfo,
		headers?: Record<string, string>,
	): Promise<string | undefined>;
	/** The HTTP credentials installed on this context, if any. */
	httpCredentials: DriverHttpCredentials | undefined;
}

export interface FakePage extends DriverPage {
	/** The browser slot this page belongs to, so a crash of one slot can close
	 * exactly its own pages. */
	readonly slot: FakeBrowserSlot;
	/** Every selector an action was performed on, in order. */
	readonly performed: string[];
	/** The live viewport, so a narrowed capture is observable. */
	viewport: { width: number; height: number };
	/** The viewport each capture ran at, so a bounded screenshot is assertable. */
	readonly capturedAt: Array<{ width: number; height: number }>;
	/** The mask each capture was given, so "masking options passed" is
	 * assertable without a real image. */
	readonly masked: Array<readonly DriverLocator[]>;
	/** How many times the window was raised (`stage_login` hand-off focus). */
	readonly focusCalls: number;
	/** Whether the hand-off banner was removed from this live document. */
	bannerRemoved: boolean;
	/** Whether this document currently carries the hand-off banner. */
	bannerInstalled: boolean;
	/** What this page's `close` reported to its listeners. */
	readonly closeReasons: DriverPageCloseReason[];
	emitConsole(entry: DriverConsoleEntry): void;
	emitNetwork(event: DriverNetworkEvent): void;
	/** Close the page. `reason` is what a real close has to decide: `user` for a
	 * window the developer closed, `server` for a context this server dropped. */
	close(reason?: DriverPageCloseReason): void;
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
	/** Every request the fake's routing layer authenticated, with the origin it
	 * authenticated for and the header it added. Never a header value from a page:
	 * the fake adds only what the provider answers. */
	readonly authorized: Array<{
		readonly url: string;
		readonly header: string;
	}>;
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
	/** The `headless` flag of every launch, in order, so a headed launch of the
	 * interactive browser is assertable without a real window. */
	readonly launchOptions: Array<{ readonly headless: boolean }>;
	/** The init scripts installed per context, in context order. */
	readonly initScripts: string[][];
	/** Simulate a browser process going away: every slot by default, or only the
	 * headless one / only the interactive one, so crash isolation between the two
	 * browsers is assertable. */
	crash(which?: "all" | "headless" | "interactive"): void;
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
	const authorized: Array<{ readonly url: string; readonly header: string }> =
		[];
	const httpCredentialsCalls: DriverHttpCredentials[] = [];
	const launchOptions: Array<{ readonly headless: boolean }> = [];
	const initScripts: string[][] = [];
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
	const launchError = options.launchError;
	let launchCount = 0;
	let contextCount = 0;
	let failGoto = false;
	let failNextGoto = false;
	let holdingGoto = false;
	const heldGotos: Array<() => void> = [];
	let holding = false;
	const held: Array<() => void> = [];
	let navigationStatusValue: number | undefined;
	/** One entry per launch: the two browser slots have separate liveness, so a
	 * crash of one leaves the other's sessions alone. */
	const slots: FakeBrowserSlot[] = [];

	const makePage = (context: FakeWorld): FakePage => {
		const consoleListeners: Array<(entry: DriverConsoleEntry) => void> = [];
		const networkListeners: Array<(event: DriverNetworkEvent) => void> = [];
		const closedListeners: Array<(reason: DriverPageCloseReason) => void> = [];
		let focusCount = 0;
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
			slot: context.slot,
			performed: performedHere,
			viewport: { width: 1280, height: 800 },
			capturedAt: [],
			masked: [],
			get focusCalls() {
				return focusCount;
			},
			bannerRemoved: false,
			bannerInstalled: context.scripts.some((script: string) =>
				script.includes(BANNER_MARKER),
			),
			closeReasons: [],
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
				// The document that issues the navigation is the one that is leaving:
				// a real driver reports that frame's URL, not the target (SEC-002).
				const from = context.url;
				context.url = url;
				const id = `r${++sequence}`;
				const navigation = {
					url,
					method: "GET",
					resourceType: "document",
					isMainFrameNavigation: true,
					...(from === "" ? {} : { initiator: from }),
				};
				const header = await context.askAuthorization(navigation, {});
				for (const listener of networkListeners)
					listener({
						kind: "request",
						id,
						method: "GET",
						url,
						resourceType: "document",
						hasAuthorization: header !== undefined,
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
			bringToFront: async () => {
				focusCount += 1;
				performedHere.push("bringToFront");
				performed.push("bringToFront");
			},
			removeBanner: async () => {
				page.bannerRemoved = true;
				page.bannerInstalled = false;
				performedHere.push("removeBanner");
				performed.push("removeBanner");
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
			close: (reason = "user") => {
				page.closeReasons.push(reason);
				for (const listener of closedListeners) listener(reason);
			},
			raw: () => rawPage,
		};
		pages.push(page);
		return page;
	};

	const newContextWhenAllowed = async (
		options: DriverContextOptions,
		slot: FakeBrowserSlot,
	): Promise<FakeContext> => {
		if (holding)
			await new Promise<void>((resolve) => {
				held.push(resolve);
			});
		return makeContext(options, slot);
	};

	const makeContext = (
		options: DriverContextOptions,
		slot: FakeBrowserSlot,
	): FakeContext => {
		contextCount += 1;
		const world: FakeWorld = {
			url: "about:blank",
			recorded: options.recordVideo !== undefined,
			absent: new Set(absentControls),
			counts: new Map(Object.entries(counts)),
			scripts: [],
			askGuard: (info) => {
				if (!options.guard) return true;
				guarded.push(info);
				return options.guard(info);
			},
			askAuthorization: async (info, headers) => {
				if (!options.authorization) return undefined;
				// The page's own credential wins, exactly like the real driver.
				if (headers.authorization !== undefined) return undefined;
				try {
					const header = await options.authorization(info);
					if (header !== undefined) authorized.push({ url: info.url, header });
					return header;
				} catch {
					// A provider that failed sends the request unauthenticated: an abort
					// would look like a broken application.
					return undefined;
				}
			},
			slot,
		};
		const own: FakePage[] = [];
		const context: FakeContext = {
			recorded: world.recorded,
			guard: options.guard,
			initScripts: world.scripts,
			addInitScript: async (script) => {
				world.scripts.push(script);
				initScripts.push(world.scripts);
				if (!script.includes(BANNER_MARKER)) return;
				for (const page of own) page.bannerInstalled = true;
			},
			runGuard: (info) => world.askGuard(info),
			authorization: options.authorization,
			runAuthorization: (info, headers) =>
				world.askAuthorization(info, headers ?? {}),
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
				for (const page of own) page.close("server");
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
		authorized,
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
		get launchOptions() {
			return launchOptions;
		},
		get initScripts() {
			return initScripts;
		},
		async launch(options: DriverLaunchOptions) {
			if (launchError) throw launchError;
			launchCount += 1;
			launchOptions.push({ headless: options.headless });
			const slot: FakeBrowserSlot = {
				headless: options.headless,
				connected: true,
			};
			slots.push(slot);
			const browser: DriverBrowser = {
				newContext: async (contextOptions) =>
					await newContextWhenAllowed(contextOptions, slot),
				close: async () => {
					slot.connected = false;
				},
				isConnected: () => slot.connected,
				onDisconnected: (listener) => {
					slot.disconnected = listener;
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
		crash(which = "all") {
			const crashed = slots.filter(
				(slot) =>
					which === "all" ||
					(which === "headless") === (slot.headless !== false),
			);
			for (const slot of crashed) {
				slot.connected = false;
				slot.disconnected?.();
			}
			for (const page of pages)
				if (crashed.some((slot) => slot === page.slot)) page.close("server");
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
