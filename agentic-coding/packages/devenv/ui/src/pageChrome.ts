// Host page chrome contract — single source: src/tui/shared/hostChrome.ts.
//
// The embedded body and the shell both read this signal, and the shared
// content framing reads `hostOwnsGaps` from it, so the module lives with the
// shared primitives and this path only re-exports it for the feature's own
// components.
export {
	type HostChrome,
	hostChromeLines,
	hostNamesPage,
	hostOwnsGaps,
	publishHostChrome,
} from "../../../../src/tui/shared/hostChrome";
