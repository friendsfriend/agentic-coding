import type { Page } from "../shell/navigation.ts";
// Structural native locations for the original breadcrumb renderer; never
// execution identities, saved history, or arbitrary host resource adoption.
export type Route = { page: Page; resource: string | null; label: string };
export const routeKey = (route: Route) =>
	JSON.stringify([route.page, route.resource]);
export const pageLabel = (route: Route) => route.label;
