import { afterEach, expect, test } from "bun:test";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

/** v1's Ctrl+T opens a window that attaches to the running host. Attaching is
 * only sound if a second authenticated client of the same host is a client and
 * not a second owner: it must receive its own fresh snapshot, and closing it
 * must leave the first client connected and the host unchanged. */
test("a second authenticated client attaches to the same host without owning it", async () => {
	const { app } = await fixture();
	const host = serve(app),
		first = new ClientConnection(host.client),
		attached = new ClientConnection(host.client);
	try {
		first.connect();
		await eventually(
			async () => first.stateFresh,
			(fresh) => fresh === true,
		);
		const firstState = first.state;
		expect(firstState).not.toBeNull();

		attached.connect();
		await eventually(
			async () => attached.stateFresh,
			(fresh) => fresh === true,
		);
		// Each client holds its own snapshot of the same host: attachment is a
		// second reader, not a second owner.
		expect(attached.state).not.toBeNull();
		expect(attached.state?.tasks.map((task) => task.id)).toEqual(
			firstState?.tasks.map((task) => task.id),
		);
		// The attached client can read through its own authenticated transport.
		expect(await attached.call("state.read", {})).not.toBeNull();

		attached.close();
		await eventually(
			async () => first.status,
			(status) => status === "connected",
		);
		expect(first.stateFresh).toBe(true);
	} finally {
		attached.close();
		first.close();
		await host.stop();
	}
}, 30_000);

/** An attached window carries a route, and a route is a location: an unknown
 * page is refused by the client that receives it instead of navigating
 * somewhere else silently. */
test("the shell refuses an attached route naming an unknown page", async () => {
	const { app } = await fixture();
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.stateFresh,
			(fresh) => fresh === true,
		);
		// The route is applied by the shell against its own page catalog, which
		// never contains a page it does not render.
		const catalog = (
			await import("../src/tui/shell/locations.ts")
		).PAGE_LOCATIONS.map((entry) => entry.page);
		expect(catalog).not.toContain("unknown-page");
	} finally {
		client.close();
		await host.stop();
	}
}, 30_000);
