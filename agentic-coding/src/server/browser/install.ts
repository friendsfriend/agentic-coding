// Browser acquisition (`add-agent-browser-sessions`, design decision 8).
//
// The application never downloads a browser on its own. This module answers
// three questions and nothing else:
//
// * **Is a browser usable, and which one?** A detected system Chrome is used
//   through Playwright's `channel: "chrome"` without any download; otherwise an
//   already-installed Chromium under `<configDir>/browsers` is used; otherwise
//   the tools answer `browser-unavailable`.
// * **What is the install doing?** `install()` is the only path that downloads,
//   and it is reachable only from an explicit Install action. Its progress is
//   the child process's own output, bounded to one line.
// * **Where does it land?** `PLAYWRIGHT_BROWSERS_PATH=<configDir>/browsers`, so
//   the opt-in install belongs to the configuration directory like every other
//   application-owned artifact.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	BUNDLED_CHROMIUM_REVISION,
	BUNDLED_PLAYWRIGHT_VERSION,
} from "./bundled-playwright.generated.ts";
import { BrowserPoolError } from "./errors.ts";
import type { DriverLaunchOptions } from "./types.ts";

/** The directory an opt-in Chromium install lands in, under the config root. */
export const BROWSERS_DIRNAME = "browsers";
/** One bounded diagnostic line; the child's output is never accumulated. */
const MAX_DETAIL_CHARS = 400;
/** How long one install may run before it is treated as failed. */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

export type BrowserInstallPhase =
	| "idle"
	| "downloading"
	| "ready"
	| "failed"
	| "cancelled";

export interface BrowserInstallState {
	readonly phase: BrowserInstallPhase;
	readonly detail?: string;
	readonly startedAt?: number;
}

export interface BrowserStatus {
	/** True when a browser the tools can launch exists right now. */
	readonly available: boolean;
	readonly source: "system-chrome" | "installed-chromium" | "none";
	readonly executablePath?: string;
	readonly channel?: "chrome";
	readonly browsersPath: string;
	readonly systemChrome?: string;
	/** Whether the browser this server would launch can open a *visible* window:
	 * a system Chrome, or the full installed Chromium build. A `headless_shell`
	 * only install reports `false`, and a login hand-off is refused before any
	 * launch is attempted. */
	readonly headed: boolean;
	readonly install: BrowserInstallState;
}

export interface BrowserInstallerOptions {
	readonly configDir: string;
	/** The candidates a system Chrome is looked for among. Injected so a test
	 * never depends on the machine's own installation. */
	readonly chromeCandidates?: readonly string[];
	/** Whether this machine can show a window. Injected for the same reason: a
	 * headless CI host must be testable without being the thing under test. */
	readonly display?: () => boolean;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

/** The well-known system Chrome locations, per platform, in preference order. */
export function systemChromeCandidates(
	platform: NodeJS.Platform = process.platform,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
	if (platform === "darwin")
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			`${env.HOME ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
		];
	if (platform === "win32")
		return [
			`${env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
			`${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
			`${env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
		];
	return [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	];
}

function firstExisting(candidates: readonly string[]): string | undefined {
	return candidates.find((candidate) => candidate !== "" && exists(candidate));
}

function exists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The executable names Playwright's Chromium builds use, per platform. */
const CHROMIUM_EXECUTABLES = [
	"Chromium",
	"Google Chrome for Testing",
	"headless_shell",
	"chrome",
	"chrome.exe",
];

/** The marker Playwright writes *after* it has extracted a browser archive, so
 * a directory without it is an interrupted install rather than a usable one. */
export const INSTALL_COMPLETE_MARKER = "INSTALLATION_COMPLETE";

/** Whether one `chromium-<revision>` directory holds a finished install. */
export function isCompleteInstall(directory: string): boolean {
	try {
		return fs.statSync(path.join(directory, INSTALL_COMPLETE_MARKER)).isFile();
	} catch {
		return false;
	}
}

/**
 * Find an installed Chromium under `browsersPath`.
 *
 * Playwright's layout is `chromium-<revision>/<platform-dir>/[...]/<binary>`;
 * the walk is depth-bounded and name-matched rather than layout-guessed, so a
 * new revision or platform directory is found without a code change.
 *
 * Two rules keep a *state* from being read as a *result*:
 *
 * * Only a directory Playwright marked `INSTALLATION_COMPLETE` counts, so an
 *   install this process interrupted (a cancel, the time limit, a crash) never
 *   resolves as a usable browser.
 * * The revision the bundled Playwright expects wins when it is known, and a
 *   *mismatch is not a fallback*: when this build knows which revision it wants
 *   and that revision is not on disk, the browser counts as not installed, so the
 *   operator is sent to the Install row (which fetches the current revision)
 *   rather than silently launched into an older one. Without a known expectation
 *   (a compiled artifact has no `browsers.json` to read) the highest complete
 *   revision is used — numerically, because a string sort would put
 *   `chromium-998` above `chromium-1000`.
 */
export function findInstalledChromium(
	browsersPath: string,
	expectedRevision?: number,
	maxDepth = 6,
	/** The executable names that count. A headed resolution passes the subset a
	 * visible window needs, so a shell-only install resolves to `undefined`. */
	executableNames: readonly string[] = CHROMIUM_EXECUTABLES,
): string | undefined {
	let revisions: string[];
	try {
		revisions = fs.readdirSync(browsersPath);
	} catch {
		return undefined;
	}
	const candidates = revisions
		.filter((name) => name.startsWith("chromium-"))
		.map((name) => ({
			name,
			revision: Number.parseInt(name.slice("chromium-".length), 10),
		}))
		.filter(
			(entry) =>
				Number.isFinite(entry.revision) &&
				isCompleteInstall(path.join(browsersPath, entry.name)),
		)
		.sort((left, right) => right.revision - left.revision);
	if (expectedRevision !== undefined) {
		// A different complete revision is *not* the browser this build asked for:
		// reporting "none" is what makes the operator install the expected one.
		const preferred = candidates.find(
			(entry) => entry.revision === expectedRevision,
		);
		if (!preferred) return undefined;
		return searchExecutable(
			path.join(browsersPath, preferred.name),
			maxDepth,
			0,
			executableNames,
		);
	}
	const ordered = candidates;
	for (const entry of ordered) {
		const found = searchExecutable(
			path.join(browsersPath, entry.name),
			maxDepth,
			0,
			executableNames,
		);
		if (found) return found;
	}
	return undefined;
}

/** The executable names a *headed* launch can use: a `headless_shell` cannot
 * open a window, so an install that only has one resolves to `undefined` and a
 * hand-off is refused instead of launching something invisible. */
const HEADED_EXECUTABLES = CHROMIUM_EXECUTABLES.filter(
	(name) => name !== "headless_shell",
);

/**
 * Whether this platform can show a window at all. Only Linux needs a display
 * server named before a headed launch can work; macOS and Windows always have
 * one. Checked *before* any launch is attempted.
 */
export function displayAvailable(
	platform: NodeJS.Platform = process.platform,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	if (platform !== "linux") return true;
	return Boolean(env.DISPLAY ?? env.WAYLAND_DISPLAY);
}

/**
 * The Chromium revision this build's Playwright expects.
 *
 * Read from the installed package when its manifest is a file on disk (a source
 * checkout), which is always the freshest answer; a compiled executable has no
 * such file, so the revision generated into the build at packaging time is used
 * instead. Only when neither is known (Playwright not installed) does the caller
 * fall back to "any complete revision" — and the install command pins the same
 * generated version so a download fetches the revision this build wants.
 */
export function expectedChromiumRevision(): number | undefined {
	try {
		const manifest = path.join(
			path.dirname(
				Bun.resolveSync("playwright-core/package.json", import.meta.dir),
			),
			"browsers.json",
		);
		const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
			browsers?: Array<{ name?: string; revision?: unknown }>;
		};
		const entry = parsed.browsers?.find(
			(candidate) => candidate.name === "chromium",
		);
		const revision = entry?.revision;
		if (typeof revision === "number" && Number.isFinite(revision))
			return revision;
		if (typeof revision === "string") {
			const parsedRevision = Number.parseInt(revision, 10);
			return Number.isFinite(parsedRevision) ? parsedRevision : undefined;
		}
		return undefined;
	} catch {
		return BUNDLED_CHROMIUM_REVISION >= 0
			? BUNDLED_CHROMIUM_REVISION
			: undefined;
	}
}

function searchExecutable(
	directory: string,
	maxDepth: number,
	depth: number,
	executableNames: readonly string[] = CHROMIUM_EXECUTABLES,
): string | undefined {
	if (depth > maxDepth) return undefined;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return undefined;
	}
	// A `.app` bundle is a directory whose binary lives at a known offset; the
	// `Contents/MacOS` walk below finds it, so nothing here special-cases macOS.
	for (const entry of entries) {
		if (entry.isFile() && executableNames.includes(entry.name))
			return path.join(directory, entry.name);
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = searchExecutable(
			path.join(directory, entry.name),
			maxDepth,
			depth + 1,
			executableNames,
		);
		if (found) return found;
	}
	return undefined;
}

export class BrowserInstaller {
	private state: BrowserInstallState = { phase: "idle" };
	private child: Bun.Subprocess | undefined;
	private cancelled = false;
	private readonly configDir: string;
	private readonly chromeCandidates: readonly string[];
	private readonly display: () => boolean;
	private readonly clock: () => number;
	private readonly log: (message: string) => void;

	constructor(options: BrowserInstallerOptions) {
		this.configDir = options.configDir;
		this.chromeCandidates =
			options.chromeCandidates ?? systemChromeCandidates();
		this.display = options.display ?? (() => displayAvailable());
		this.clock = options.now ?? (() => Date.now());
		this.log = options.log ?? (() => {});
	}

	get browsersPath(): string {
		return path.join(this.configDir, BROWSERS_DIRNAME);
	}

	/** The system Chrome this machine has, if any. */
	systemChrome(): string | undefined {
		return firstExisting(this.chromeCandidates);
	}

	/** The Chromium the opt-in install put on disk, if any. */
	installedChromium(): string | undefined {
		return findInstalledChromium(this.browsersPath, expectedChromiumRevision());
	}

	/** What is usable now. `install` is reported as its own state, so a UI can
	 * say "not installed" and "installing" without conflating them. */
	status(): BrowserStatus {
		// The cheap answer first: no display means no headed capability at all, and
		// the resolution below is a synchronous directory walk on the server's
		// event loop, repeated on every Settings poll (PERF-003).
		const canShowWindow = this.display();
		const systemChrome = this.systemChrome();
		const installed = systemChrome ? undefined : this.installedChromium();
		// A headed-capable browser *and* a platform that can show a window: a
		// Chromium that cannot open one is not a capability this server has. One
		// walk answers both questions, because the resolved executable names which
		// build it is; only an ambiguous answer (the walk found the shell, though a
		// revision directory can hold both binaries) pays for the headed-only walk.
		const headed =
			canShowWindow &&
			(systemChrome !== undefined ||
				(installed !== undefined &&
					(HEADED_EXECUTABLES.includes(path.basename(installed)) ||
						this.headedBrowser() !== undefined)));
		if (systemChrome)
			return {
				available: true,
				source: "system-chrome",
				executablePath: systemChrome,
				channel: "chrome",
				browsersPath: this.browsersPath,
				systemChrome,
				headed,
				install: this.state,
			};
		return {
			available: installed !== undefined,
			source: installed ? "installed-chromium" : "none",
			...(installed ? { executablePath: installed } : {}),
			browsersPath: this.browsersPath,
			headed,
			install: this.state,
		};
	}

	/** The executable a headed launch would use: a system Chrome, or the full
	 * (non `headless_shell`) Chromium build of the expected revision. */
	private headedBrowser():
		| { readonly executablePath: string; readonly channel?: "chrome" }
		| undefined {
		const systemChrome = this.systemChrome();
		if (systemChrome)
			return { executablePath: systemChrome, channel: "chrome" };
		const installed = findInstalledChromium(
			this.browsersPath,
			expectedChromiumRevision(),
			6,
			HEADED_EXECUTABLES,
		);
		return installed ? { executablePath: installed } : undefined;
	}

	/**
	 * Whether a hand-off could open a window here, and why not when it could not.
	 * Both checks are cheap and neither launches anything: the routes ask this
	 * before a hand-off is queued, so a machine that cannot show a window never
	 * starts a hidden process for one.
	 */
	headedAvailability():
		| { readonly ok: true }
		| {
				readonly ok: false;
				readonly reason: "no-display" | "headless-only-browser";
		  } {
		if (!this.display()) return { ok: false, reason: "no-display" };
		if (!this.headedBrowser())
			return { ok: false, reason: "headless-only-browser" };
		return { ok: true };
	}

	/**
	 * How to launch a browser, or the refusal the tools report. A system Chrome
	 * is preferred when present: it costs no download and is what the developer
	 * already runs. Otherwise the installed Chromium is launched by path.
	 *
	 * `headed: true` asks for the interactive browser a login hand-off needs. The
	 * display and headed-capability checks happen **before** any launch, so a
	 * machine that cannot show a window never starts a hidden process for it.
	 */
	resolveLaunch(
		options: { readonly headed?: boolean } = {},
	): DriverLaunchOptions {
		if (options.headed) {
			const available = this.headedAvailability();
			if (!available.ok) {
				if (available.reason === "no-display")
					throw new BrowserPoolError(
						"login-handoff-unavailable",
						'this platform has no display (neither DISPLAY nor WAYLAND_DISPLAY is set), so a login window cannot be shown; run the server where a display exists, or set interactiveLogin to "never" in stages/policy.json',
						503,
						"no-display",
					);
				throw new BrowserPoolError(
					"login-handoff-unavailable",
					"no browser that can show a window is installed: install Chromium from Settings → Browser (Browser → Install), or install Google Chrome, and call stage_login again",
					503,
					"headless-only-browser",
				);
			}
			const headed = this.headedBrowser();
			if (!headed)
				throw new BrowserPoolError(
					"login-handoff-unavailable",
					"no browser that can show a window is installed; install Chromium from Settings → Browser → Install",
					503,
					"headless-only-browser",
				);
			return { headless: false, ...headed };
		}
		const systemChrome = this.systemChrome();
		if (systemChrome)
			return {
				headless: true,
				executablePath: systemChrome,
				channel: "chrome",
			};
		const installed = this.installedChromium();
		if (installed) return { headless: true, executablePath: installed };
		throw new BrowserPoolError(
			"browser-unavailable",
			"no browser is available: install Chromium from Settings → Browser (Browser → Install), or install Google Chrome, and call browser_open again. Nothing is downloaded until you ask for it.",
			503,
		);
	}

	/** Whether an install is in flight. */
	get installing(): boolean {
		return this.state.phase === "downloading";
	}

	/**
	 * Start the opt-in download. Idempotent while one runs; a completed or
	 * cancelled run may be retried, and a retry after a failure is explicit.
	 */
	async install(): Promise<BrowserStatus> {
		if (this.installing) return this.status();
		const command = await installCommand(Bun.which("bun"));
		if (!command) {
			this.state = {
				phase: "failed",
				detail:
					"no package runner is available to download Chromium; install Google Chrome instead, or run the install with a package manager that provides `bun`",
			};
			return this.status();
		}
		this.cancelled = false;
		this.state = { phase: "downloading", startedAt: this.clock() };
		void this.runInstall(command);
		return this.status();
	}

	/** Ask the running download to stop. Whatever it extracted stays on disk but
	 * carries no completion marker, so nothing reads it as an installed browser;
	 * the next attempt replaces the directory. */
	async cancel(): Promise<BrowserStatus> {
		if (!this.installing) return this.status();
		this.cancelled = true;
		this.child?.kill();
		this.child = undefined;
		this.state = { phase: "cancelled", detail: "the download was cancelled" };
		return this.status();
	}

	private async runInstall(command: readonly string[]): Promise<void> {
		try {
			const child = Bun.spawn([...command], {
				// A minimal environment: the browser install needs a PATH, a home for
				// the package cache and the browsers directory, and nothing else. The
				// server's own secrets (provider keys, integration tokens) have no
				// business in a child that runs code fetched from a registry.
				env: installChildEnvironment(this.browsersPath),
				stdout: "pipe",
				stderr: "pipe",
			});
			this.child = child;
			const timer = setTimeout(() => {
				this.log("browser install exceeded its time limit");
				child.kill();
			}, INSTALL_TIMEOUT_MS);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			clearTimeout(timer);
			this.child = undefined;
			if (this.cancelled) {
				this.state = {
					phase: "cancelled",
					detail: "the download was cancelled",
				};
				return;
			}
			if (exitCode !== 0) {
				this.state = {
					phase: "failed",
					detail:
						lastLine(stderr) ?? lastLine(stdout) ?? `exit code ${exitCode}`,
				};
				return;
			}
			const executable = this.installedChromium();
			this.state = executable
				? { phase: "ready", detail: executable }
				: {
						phase: "failed",
						detail:
							"the download finished but no Chromium executable was found; try again",
					};
		} catch (error) {
			if (this.cancelled) {
				this.state = {
					phase: "cancelled",
					detail: "the download was cancelled",
				};
				return;
			}
			this.state = {
				phase: "failed",
				detail: message(error).slice(0, MAX_DETAIL_CHARS),
			};
		}
	}
}

/** The environment one browser install runs with: paths and a home, no secrets. */
export function installChildEnvironment(
	browsersPath: string,
	platform: NodeJS.Platform = process.platform,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const child: Record<string, string> = {
		PLAYWRIGHT_BROWSERS_PATH: browsersPath,
		PATH: env.PATH ?? "",
		HOME: env.HOME ?? os.homedir(),
	};
	if (env.TMPDIR) child.TMPDIR = env.TMPDIR;
	if (platform === "win32") {
		for (const name of [
			"SystemRoot",
			"USERPROFILE",
			"APPDATA",
			"LOCALAPPDATA",
			"TEMP",
			"TMP",
			"PATHEXT",
		]) {
			const value = env[name];
			if (value) child[name] = value;
		}
	}
	return child;
}

/** The last non-empty line of one output stream, bounded. */
function lastLine(text: string): string | undefined {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const last = lines[lines.length - 1];
	return last === undefined ? undefined : last.slice(0, MAX_DETAIL_CHARS);
}

/**
 * The command that downloads Chromium into `PLAYWRIGHT_BROWSERS_PATH`.
 *
 * The packaged Playwright CLI is used when it resolves on disk, which is how
 * `bun run dev` and a source checkout run; a compiled executable has no such
 * file, so `bun x playwright-core@<version>` is the documented fallback. Both
 * paths set the config-owned browsers directory and neither runs until an
 * explicit install asks for it.
 */
export async function installCommand(
	bun: string | null,
): Promise<string[] | undefined> {
	if (!bun) return undefined;
	const cli = resolvePlaywrightCli();
	if (cli) return [bun, cli, "install", "chromium"];
	// The packaged executable has no CLI file on disk, so the install runs through
	// the package runner. The version is pinned when it is readable (the source
	// checkout) and left to the registry in a compiled artifact, where the
	// bundled package's own manifest is not a file this process can read.
	const version = await playwrightVersion();
	return [
		bun,
		"x",
		version ? `playwright-core@${version}` : "playwright-core",
		"install",
		"chromium",
	];
}

/** The Playwright CLI, when it exists as a real file this process can run. */
function resolvePlaywrightCli(): string | undefined {
	try {
		const manifest = Bun.resolveSync(
			"playwright-core/package.json",
			import.meta.dir,
		);
		const cli = path.join(path.dirname(manifest), "cli.js");
		return exists(cli) ? cli : undefined;
	} catch {
		return undefined;
	}
}

/** The Playwright version to pin the install command to: the installed package's
 * own version, or the one generated into this build when the manifest is not a
 * file on disk (a compiled artifact). */
async function playwrightVersion(): Promise<string | undefined> {
	try {
		const manifest = Bun.resolveSync(
			"playwright-core/package.json",
			import.meta.dir,
		);
		const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
			version?: unknown;
		};
		if (typeof parsed.version === "string") return parsed.version;
	} catch {
		// A compiled artifact has no such file: the generated version is the pin.
	}
	return BUNDLED_PLAYWRIGHT_VERSION === ""
		? undefined
		: BUNDLED_PLAYWRIGHT_VERSION;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
