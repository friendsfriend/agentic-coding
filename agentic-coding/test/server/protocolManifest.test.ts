import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	OBSERVATION_OWNERSHIP,
	ROUTE_DOMAINS,
	ROUTE_OWNERSHIP,
	ROUTE_REQUESTS,
	routeOwner,
	SERVER_API_VERSION,
} from "../../src/server/protocol.ts";

/**
 * Route manifest guarantees (establish-opencode-boundaries, tasks 2.1/2.2):
 * every served route is owned, every route with a body decodes through a
 * contract schema, and every observation kind (Git, wiki, Herdr, workflow,
 * telemetry) names the ownership domain that serves it.
 */
const served = (): Array<{ method: string; path: string }> => {
	const app = readFileSync("src/server/app.ts", "utf8");
	const rows: Array<{ method: string; path: string }> = [];
	for (const match of app.matchAll(
		/if \(method === "(GET|POST)" && path === "(\/api\/v1\/[a-z/-]+)"\)/g,
	))
		rows.push({ method: match[1] ?? "", path: match[2] ?? "" });
	return rows;
};

describe("route ownership manifest", () => {
	test("every served route has an ownership entry", () => {
		const missing = served().filter(
			(route) =>
				!ROUTE_OWNERSHIP.some(
					(entry) => entry.path === route.path && entry.method === route.method,
				),
		);
		expect(missing).toEqual([]);
	});

	test("every owned route is served or is a documented prefix route", () => {
		const routes = served();
		const orphaned = ROUTE_OWNERSHIP.filter(
			(entry) =>
				!entry.path.endsWith("*") &&
				!routes.some(
					(route) => route.path === entry.path && route.method === entry.method,
				),
		);
		expect(orphaned).toEqual([]);
	});

	test("ownership is resolvable for every route", () => {
		for (const route of served())
			expect(routeOwner(route.method, route.path)).toBeDefined();
	});

	test("the version prefix is owned consistently", () => {
		expect(SERVER_API_VERSION).toBe("v1");
		for (const entry of ROUTE_OWNERSHIP)
			expect(entry.path.startsWith(`/api/${SERVER_API_VERSION}/`)).toBe(true);
	});
});

describe("request contracts", () => {
	test("every POST route decodes through a registered contract schema", () => {
		const posts = served().filter((route) => route.method === "POST");
		const unregistered = posts.filter(
			(route) => !ROUTE_REQUESTS.some((entry) => entry.path === route.path),
		);
		expect(unregistered).toEqual([]);
	});

	test("no request contract is registered twice", () => {
		const paths = ROUTE_REQUESTS.map((entry) => entry.path);
		expect(new Set(paths).size).toBe(paths.length);
		for (const entry of ROUTE_REQUESTS)
			expect(routeOwner("POST", entry.path)).toBeDefined();
	});

	test("app.ts decodes bodies through the manifest, not inline schemas", () => {
		const app = readFileSync("src/server/app.ts", "utf8");
		expect(app).toContain("decodeRouteRequest");
		// a route body decoded with a schema chosen at the call site would let
		// the manifest and the wire drift apart
		expect(app).not.toMatch(/decodeRequest\(\s*"server\./);
	});
});

describe("observation ownership", () => {
	test("every observation kind names a domain exactly once", () => {
		const kinds = OBSERVATION_OWNERSHIP.map((entry) => entry.kind);
		expect(new Set(kinds).size).toBe(kinds.length);
		// the union in the contract layer is the source of kinds
		const source = readFileSync("src/contracts/environment.ts", "utf8");
		for (const kind of kinds) expect(source).toContain(`"${kind}"`);
	});

	test("every observation kind is served by the observe route", () => {
		expect(
			ROUTE_OWNERSHIP.some(
				(entry) => entry.path === "/api/v1/observe" && entry.method === "POST",
			),
		).toBe(true);
	});

	test("Git, wiki, Herdr and workflow kinds map onto owned domains", () => {
		const domains = new Set<string>(ROUTE_DOMAINS);
		for (const entry of OBSERVATION_OWNERSHIP)
			expect(domains.has(entry.domain)).toBe(true);
		const byKind = Object.fromEntries(
			OBSERVATION_OWNERSHIP.map((entry) => [entry.kind, entry.domain]),
		);
		expect(byKind["local-changes"]).toBe("git");
		expect(byKind["local-diff"]).toBe("git");
		expect(byKind["wiki-changes"]).toBe("wiki");
		expect(byKind["wiki-diff"]).toBe("wiki");
		expect(byKind.dashboard).toBe("workflow");
		expect(byKind["repair-preview"]).toBe("workflow");
	});
});
