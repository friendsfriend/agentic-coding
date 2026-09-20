// Dashboard live subscriptions and shell app actions
// (establish-opencode-boundaries, tasks 4.6/5.6/6.4).
//
// The canonical seam is `tui/context/app-actions.ts`; this module re-exports it
// so the dashboard's own modules keep one import site.
export * from "../context/app-actions.ts";
