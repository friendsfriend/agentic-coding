// Negative fixture: the presentational package importing a domain package.
import type { App } from "@devenv/types";

export const view = (app: App) => app.name;
