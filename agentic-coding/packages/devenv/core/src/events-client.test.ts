import { expect, test } from "bun:test";
import type { ClientDeps } from "./client-types";
import { getActionHistory, getActionLogs } from "./events-client";

test("getActionHistory requests only older history when asked", async () => {
	let url = "";
	const fetchMock = (async (input: string | URL | Request) => {
		url = String(input);
		return Response.json([]);
	}) as unknown as typeof fetch;
	const deps: ClientDeps = {
		baseUrl: "http://dev",
		fetchFn: fetchMock,
		sseFetchFn: fetchMock,
	};

	await getActionHistory(deps, "older");
	expect(url).toBe("http://dev/api/actions/history?scope=older&limit=50000");
});

test("getActionLogs requests only selected action node logs", async () => {
	let url = "";
	const fetchMock = (async (input: string | URL | Request) => {
		url = String(input);
		return Response.json([]);
	}) as unknown as typeof fetch;
	const deps: ClientDeps = {
		baseUrl: "http://dev",
		fetchFn: fetchMock,
		sseFetchFn: fetchMock,
	};

	await getActionLogs(deps, "run / 1", "step / 1");
	expect(url).toBe(
		"http://dev/api/actions/logs?runId=run+%2F+1&stepId=step+%2F+1",
	);
});
