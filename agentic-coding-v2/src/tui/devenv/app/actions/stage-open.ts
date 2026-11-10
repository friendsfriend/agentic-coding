// Opening one stage application in the developer's default browser
// (`open-stage-from-environments`).
//
// This is the local half of the feature: the TUI hands the *configured* URL to
// the platform's opener and nothing else happens — no stage session, no token, no
// query parameter, no server call. The opener is injectable so a test never
// launches a browser, and the argv builder is pure so the launch shape is
// testable per platform.
//
// The platform convention is the one this package already uses for the log file
// (`actions/util-actions.ts`) and the shell uses for evidence
// (`src/tui/shared/side-app.ts`): `open` on macOS, `xdg-open` elsewhere and
// `cmd /c start` on Windows. A URL cannot reuse `systemOpenerSideApp` as-is: it
// derives the launch directory from the path, which a URL does not have, and a
// browser hand-off must not become a tmux window.
import { isOpenableUrl } from "./stage-picker-model.ts";

export interface BrowserOpenOutcome {
	ok: boolean;
	/** Why the launch failed, when it did. */
	reason?: string;
}

/** One browser launch. Injected in tests; never launches anything there. */
export type BrowserOpener = (url: string) => Promise<BrowserOpenOutcome>;

/** The argv of one platform opener, without any shell string. */
export function browserOpenerArgv(
	url: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform === "darwin") return ["open", url];
	if (platform === "win32") return ["cmd", "/c", "start", "", url];
	return ["xdg-open", url];
}

/**
 * Hand one URL to the platform's default browser and answer how the hand-off
 * went: a zero exit status is the opener's own success. The child is awaited
 * because a missing `xdg-open` (or a headless host) is exactly the failure the
 * caller has to report — an `unref`d spawn would lose it.
 */
export const openInSystemBrowser: BrowserOpener = async (url) => {
	if (!isOpenableUrl(url))
		return { ok: false, reason: `${url} is not an http(s) URL` };
	const argv = browserOpenerArgv(url);
	try {
		const child = Bun.spawn(argv, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		const status = await child.exited;
		if (status === 0) return { ok: true };
		return {
			ok: false,
			reason: (
				stderr.trim() || `${argv[0]} exited with status ${status}`
			).slice(0, 200),
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
};
