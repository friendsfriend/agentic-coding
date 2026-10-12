import { expect, test } from "bun:test";
import type { ClientDeps } from "./client-types.ts";
import { getAppSlots, releaseApp } from "./environment-client.ts";

test("reads the slot list and drops malformed rows", async () => {
	const calls: string[] = [];
	const deps = {
		baseUrl: "http://server",
		fetchFn: async (url: string) => {
			calls.push(url);
			return Response.json({
				ok: true,
				value: [
					{
						app: "shop",
						holder: "workflow:run-a",
						status: "running",
						waiters: ["workflow:run-b"],
					},
					{ app: "api", holder: null, status: null, waiters: [] },
					{ app: 7, holder: null, status: null, waiters: [] },
				],
			});
		},
		onError: () => {},
	} as unknown as ClientDeps;
	expect(await getAppSlots(deps)).toEqual([
		{
			app: "shop",
			holder: "workflow:run-a",
			status: "running",
			waiters: ["workflow:run-b"],
		},
		{ app: "api", holder: null, status: null, waiters: [] },
	]);
	expect(calls).toEqual(["http://server/api/v1/environment/apps/slots"]);
});

test("keeps the richer slot fields when the server sends them", async () => {
	const deps = {
		baseUrl: "http://server",
		fetchFn: async () =>
			Response.json({
				ok: true,
				value: [
					{
						app: "shop",
						holder: "workflow:a",
						status: "running",
						waiters: ["workflow:b"],
						waiting: [
							{
								owner: "workflow:b",
								since: "2026-01-01T00:00:00.000Z",
								position: 1,
							},
						],
						holderSince: "2026-01-01T00:00:00.000Z",
						idleMs: 1000,
						idleTtlMs: 60000,
						endpoints: { api: "http://127.0.0.1:8080" },
					},
				],
			}),
		onError: () => {},
	} as unknown as ClientDeps;
	expect(await getAppSlots(deps)).toEqual([
		{
			app: "shop",
			holder: "workflow:a",
			status: "running",
			waiters: ["workflow:b"],
			waiting: [
				{
					owner: "workflow:b",
					since: "2026-01-01T00:00:00.000Z",
					position: 1,
				},
			],
			holderSince: "2026-01-01T00:00:00.000Z",
			idleMs: 1000,
			idleTtlMs: 60000,
			endpoints: { api: "http://127.0.0.1:8080" },
		},
	]);
});

test("release posts to the app's release route", async () => {
	const calls: Array<{ url: string; method?: string }> = [];
	const deps = {
		baseUrl: "http://server",
		fetchFn: async (url: string, init?: RequestInit) => {
			calls.push({ url, method: init?.method });
			return Response.json({ ok: true, value: {} });
		},
		onError: () => {},
	} as unknown as ClientDeps;
	await releaseApp(deps, "shop app");
	expect(calls).toEqual([
		{
			url: "http://server/api/v1/environment/apps/shop%20app/release",
			method: "POST",
		},
	]);
});

test("a refused slot read raises through the client error handler", async () => {
	const errors: Array<[string, string]> = [];
	const deps = {
		baseUrl: "http://server",
		fetchFn: async () =>
			new Response(JSON.stringify({ message: "no capability" }), {
				status: 503,
			}),
		onError: (title: string, message: string) => errors.push([title, message]),
	} as unknown as ClientDeps;
	await expect(getAppSlots(deps)).rejects.toThrow("no capability");
	expect(errors).toEqual([["HTTP 503 Error", "no capability"]]);
});
