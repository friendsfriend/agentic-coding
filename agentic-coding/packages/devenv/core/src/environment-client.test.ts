import { expect, test } from "bun:test";
import type { ClientDeps } from "./client-types.ts";
import { getAppSlots } from "./environment-client.ts";

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
