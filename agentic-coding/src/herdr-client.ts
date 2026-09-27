// Compatibility shim (add-multiplexer-adapters, task 1.2): the single shared
// Herdr CLI boundary now lives in src/multiplexer/herdr/cli.ts. Existing
// imports keep resolving here.
export * from "./multiplexer/herdr/cli.ts";
