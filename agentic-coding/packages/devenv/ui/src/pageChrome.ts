import { createSignal } from "solid-js";

/**
 * Host page chrome contract (compose-unified-feature-shell chrome rule).
 *
 * One module-level signal, same shape as `src/tui/shared/keybinds.ts`: the
 * embedded feature publishes its surrounding chrome once and every identity row
 * and line-budget consumer reads it. Nothing here imports the shell or the
 * environment feature, so either side can own the signal.
 *
 * Nothing published = standalone `devenv`, which renders its own header and
 * footer and keeps every identity row.
 */
export interface HostChrome {
	/** Rows of chrome the host renders around the embedded body. */
	lines: number;
	/** The host chrome already names the page (a breadcrumb row is present). */
	namesPage: boolean;
}

const [hostChrome, setHostChrome] = createSignal<HostChrome | undefined>(
	undefined,
);

/** Publish the host's chrome; `undefined` restores standalone behavior. */
export function publishHostChrome(chrome?: HostChrome): void {
	setHostChrome(chrome);
}

/** Rows to reserve for chrome: the host's own when it renders any. */
export function hostChromeLines(fallback: number): number {
	return hostChrome()?.lines ?? fallback;
}

/** True while surrounding chrome already names the page. */
export function hostNamesPage(): boolean {
	return hostChrome()?.namesPage ?? false;
}
