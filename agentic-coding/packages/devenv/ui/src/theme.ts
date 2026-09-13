// Single theme registry, store and asset set. Canonical source:
// src/tui/shared/theme.ts (assets live in src/tui/themes). This package's
// historical copy of the 33 built-in theme JSONs is removed; the shared theme
// module is the only registry so a selection updates every component family
// through one Solid signal.
export * from "../../../../src/tui/shared/theme";
