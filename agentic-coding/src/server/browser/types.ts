// Browser driver boundary (`add-agent-browser-sessions`).
//
// The pool and the tools never talk to Playwright directly: they talk to this
// narrow surface, which is the only place Playwright's own types appear. Two
// reasons, both structural:
//
// * **One process owns one browser.** The driver is an *adapter* factory, not
//   an API mirror: a session's page, context and browser are opaque handles
//   whose operations are exactly the operations the tools offer. A fake driver
//   then exercises the whole pool, session, recording and tool pipeline with no
//   Chromium at all (`fake-driver.ts`).
// * **Refs are the tool contract, selectors are the driver contract.** The
//   driver never sees a `ref`; the session resolves `[ref=eN]` to the injected
//   `[data-ac-ref="eN"]` selector before any action reaches the driver.

/** One console message a page produced. */
export interface DriverConsoleEntry {
	readonly type: string;
	readonly text: string;
	readonly location?: string;
}

/** One network observation. A request is reported when it starts and matched
 * again when it answers or fails, so the session can show an in-flight request
 * instead of dropping it. */
export type DriverNetworkEvent =
	| {
			readonly kind: "request";
			readonly id: string;
			readonly method: string;
			readonly url: string;
			readonly resourceType: string;
	  }
	| {
			readonly kind: "response";
			readonly id: string;
			readonly status: number;
			readonly ok: boolean;
	  }
	| { readonly kind: "failed"; readonly id: string; readonly error: string };

export interface DriverScreenshotOptions {
	readonly type: "png" | "jpeg";
	readonly quality?: number;
	readonly fullPage: boolean;
	/** Restrict the capture to one element, by CSS selector. */
	readonly selector?: string;
	/** Elements whose pixels are covered before the shot
	 * (`add-stage-testing-foundation`): a password field, or a field a credential
	 * was typed into, is never part of a returned or stored image. */
	readonly mask?: readonly DriverLocator[];
}

/** One way a tool names an element without a CSS selector: an accessible label,
 * a role plus its accessible name, or a raw selector. A login recipe declares
 * its controls this way, so the same recipe works across pages of one form
 * (`add-stage-testing-foundation`). */
export interface DriverLocator {
	readonly label?: string;
	readonly role?: string;
	readonly name?: string;
	readonly selector?: string;
}

/** The stable key of one locator descriptor, resolved in the order the drivers
 * use (selector, then label, then role+name), so a test can name the control a
 * fake driver should treat as absent. */
export function driverLocatorKey(locator: DriverLocator): string {
	if (locator.selector !== undefined && locator.selector !== "")
		return `selector=${locator.selector}`;
	if (locator.label !== undefined && locator.label !== "")
		return `label=${locator.label}`;
	return `role=${locator.role ?? ""}[name=${locator.name ?? ""}]`;
}

/** One request a guarded context is about to make, as the guard sees it. */
export interface DriverRequestInfo {
	readonly url: string;
	readonly method: string;
	readonly resourceType: string;
	/** True for a main-frame document navigation: a tool, a script, a redirect
	 * or a link, but not an image, a font or an XHR. */
	readonly isMainFrameNavigation: boolean;
}

/** A stage's request guard: `false` aborts the request. Only a stage-bound
 * context has one. */
export type DriverRequestGuard = (request: DriverRequestInfo) => boolean;

export interface DriverHttpCredentials {
	readonly username: string;
	readonly password: string;
}

export interface DriverContextOptions {
	readonly viewport: { readonly width: number; readonly height: number };
	readonly recordVideo?: {
		readonly dir: string;
		readonly size: { readonly width: number; readonly height: number };
	};
	readonly storageState?: unknown;
	/** HTTP basic credentials, for a stage whose recipe is `http-basic`. */
	readonly httpCredentials?: DriverHttpCredentials;
	/** The stage's request guard. It is a context option because the guard must
	 * survive a recording's context swap. */
	readonly guard?: DriverRequestGuard;
}

/** One page of one session. Everything a tool can do to a page is one method
 * here; the session's `ref` resolution happens above this line. */
export interface DriverPage {
	url(): string;
	/** Navigate, bounded by `timeoutMs`. Resolves to the response status when
	 * the transport reports one. */
	goto(url: string, timeoutMs: number): Promise<number | null>;
	title(): Promise<string>;
	content(): Promise<string>;
	evaluate(expression: string): Promise<unknown>;
	/** The accessibility-shaped tree with `[ref=eN]` markers, and the injected
	 * `data-ac-ref` attributes that make those refs actionable. */
	snapshot(): Promise<string>;
	setViewportSize(size: {
		readonly width: number;
		readonly height: number;
	}): Promise<void>;
	click(selector: string, timeoutMs: number): Promise<void>;
	fill(selector: string, value: string, timeoutMs: number): Promise<void>;
	press(selector: string, key: string, timeoutMs: number): Promise<void>;
	selectOption(
		selector: string,
		values: readonly string[],
		timeoutMs: number,
	): Promise<void>;
	hover(selector: string, timeoutMs: number): Promise<void>;
	/** Fill one element named by a locator descriptor (a login field). */
	fillField(
		locator: DriverLocator,
		value: string,
		timeoutMs: number,
	): Promise<void>;
	/** Click one control named by a locator descriptor (a login submit). */
	clickControl(locator: DriverLocator, timeoutMs: number): Promise<void>;
	/** Wait until one control named by a locator descriptor is visible; throws on
	 * timeout, which is how a login step learns its control is absent. */
	waitForControl(locator: DriverLocator, timeoutMs: number): Promise<void>;
	/** How many elements one locator matches, for the "is an MFA prompt shown"
	 * probe. */
	locatorCount(locator: DriverLocator): Promise<number>;
	waitForSelector(selector: string, timeoutMs: number): Promise<void>;
	waitForText(text: string, timeoutMs: number): Promise<void>;
	waitForUrl(pattern: string, timeoutMs: number): Promise<void>;
	textContent(selector: string, timeoutMs: number): Promise<string>;
	screenshot(options: DriverScreenshotOptions): Promise<Uint8Array>;
	onConsole(listener: (entry: DriverConsoleEntry) => void): void;
	onNetwork(listener: (event: DriverNetworkEvent) => void): void;
	/** A page that closed on its own (a crashed renderer, a closed tab). */
	onClosed(listener: () => void): void;
	/** The underlying page object, handed only to `browser_run_script`. It is
	 * the session's page and nothing else — never the server's own handles. */
	raw(): unknown;
}

/** One recorded video of one context. It is grabbed before the context closes
 * and saved afterwards: Playwright finalizes the file when the context closes,
 * so a save that ran earlier would wait for a file that does not exist yet. */
export interface DriverVideo {
	saveAs(path: string): Promise<void>;
}

/** One browser context: one isolated cookie/storage jar, one session. */
export interface DriverContext {
	/** The context's first page. A recording context is created fresh, so the
	 * pool asks for its page after construction. */
	page(): Promise<DriverPage>;
	close(): Promise<void>;
	storageState(): Promise<unknown>;
	/** Install HTTP credentials on a live context (`http-basic` login, and the
	 * credential flow's own reload). */
	setHttpCredentials(credentials: DriverHttpCredentials): Promise<void>;
	/** The recorded video, or `undefined` when this context does not record. */
	video(): DriverVideo | undefined;
	/** A page that is currently open in this context (a script may open one). */
	pages(): readonly DriverPage[];
	raw(): unknown;
}

export interface DriverLaunchOptions {
	readonly headless: boolean;
	/** An explicit Chromium/Chrome binary, when one was resolved. */
	readonly executablePath?: string;
	/** Playwright's `channel` selector, used for a detected system Chrome. */
	readonly channel?: "chrome";
}

export interface DriverBrowser {
	newContext(options: DriverContextOptions): Promise<DriverContext>;
	close(): Promise<void>;
	isConnected(): boolean;
	onDisconnected(listener: () => void): void;
}

/** The one seam the pool is built against. `launch` is called again after a
 * crash, so a driver is a factory, not a handle. */
export interface BrowserDriver {
	launch(options: DriverLaunchOptions): Promise<DriverBrowser>;
}
