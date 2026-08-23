// Global lifecycle hooks shared between the TUI shell (index.tsx) and
// dashboard views. The shell registers these on startup so deeply nested
// components can request shutdown or renderer teardown without prop drilling.
declare global {
	var __requestShutdown: (() => void) | undefined;
	var __renderer: { destroy(): void } | undefined;
}

export {};
