// One version source for the whole product: the root package.json. The
// executable, the TUI and the headless server all report this value, and the
// build embeds it (`AGENTIC_CODING_VERSION`) for the `--user-agent`.
import rootPackageJson from "../package.json";

export const APP_VERSION: string = rootPackageJson.version;
