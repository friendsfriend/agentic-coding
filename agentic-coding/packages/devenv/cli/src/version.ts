import rootPackageJson from "../../../../package.json";

// One version source for the whole product: the root package.json. The Go
// backend receives the same value through `-ldflags -X` at build time
// (scripts/build.ts), so executable, TUI and backend can never disagree.
export const APP_VERSION = rootPackageJson.version;
