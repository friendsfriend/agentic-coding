import { afterEach, expect, test } from "bun:test";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("authenticated standalone bridge retains its own identities and consumes uncertain attempts without replay", async () => {
	const oldURL = process.env.AGENTIC_CODING_V2_OPENCODE_URL,
		oldToken = process.env.AGENTIC_CODING_V2_OPENCODE_TOKEN;
	let creates = 0,
		messages = 0,
		fail = false;
	const native = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			expect(request.headers.get("authorization")).toBe(
				"Bearer fake-standalone-secret",
			);
			const url = new URL(request.url);
			expect(url.searchParams.get("directory")).toBeTruthy();
			if (url.pathname === "/session") {
				creates++;
				const body = await request.json();
				expect(body.permission).toEqual([
					{ permission: "*", pattern: "*", action: "deny" },
				]);
				return Response.json({ id: `ses_fixture${creates}` });
			}
			if (url.pathname.endsWith("/message")) {
				messages++;
				if (fail)
					return new Response(
						"backend error including fake-standalone-secret",
						{ status: 500 },
					);
				return Response.json({
					parts: [{ type: "text", text: "fake-standalone-secret answer" }],
				});
			}
			return new Response(null, { status: 404 });
		},
	});
	let host: ReturnType<typeof serve> | undefined;
	let client: ClientConnection | undefined;
	try {
		process.env.AGENTIC_CODING_V2_OPENCODE_URL = native.url.origin;
		process.env.AGENTIC_CODING_V2_OPENCODE_TOKEN = "fake-standalone-secret";
		const { app, config } = await fixture();
		host = serve(app, 0);
		client = new ClientConnection(host.client);
		client.connect();
		await eventually(
			() => Promise.resolve(client?.status),
			(status) => status === "connected",
		);
		const inventory = await client.call("standalone.read", {});
		expect(inventory.sessions).toEqual([]);
		expect(inventory.opencodeAvailable).toBe(true);
		expect(inventory.piAvailable).toBe(false);
		const profile = config.profiles[0]?.id,
			repository = config.repositories[0];
		if (!profile || !repository)
			throw new Error("Fixture missing native profile/repository");
		const session = await client.call("standalone.create", {
			mode: "opencode",
			title: "Owned",
			profile,
			repository,
		});
		expect(session.status).toBe("ready");
		expect(JSON.stringify(session)).not.toContain("ses_fixture");
		const reply = await client.call("standalone.send", {
			id: session.id,
			content: "Hello",
			revision: session.revision,
			requestId: "attempt-1",
		});
		expect(reply.messages.at(-1)?.content).toBe("[redacted] answer");
		await expect(
			client.call("standalone.send", {
				id: session.id,
				content: "Hello",
				revision: reply.revision,
				requestId: "attempt-1",
			}),
		).rejects.toThrow();
		expect(messages).toBe(1);
		await expect(
			client.call("session.send", {
				id: Number(session.id),
				content: "Wrong mode",
				requestId: "wrong",
			}),
		).rejects.toThrow();
		await expect(
			client.call("standalone.read", { id: "ses_foreign" }),
		).rejects.toThrow();
		await expect(
			client.call("standalone.configure", {
				id: session.id,
				revision: session.revision,
				profile,
			}),
		).rejects.toThrow();
		fail = true;
		await expect(
			client.call("standalone.send", {
				id: session.id,
				content: "Uncertain",
				revision: reply.revision,
				requestId: "attempt-2",
			}),
		).rejects.toThrow();
		const uncertain = (await client.call("standalone.read", { id: session.id }))
			.sessions[0];
		expect(uncertain?.status).toBe("uncertain");
		await expect(
			client.call("standalone.send", {
				id: session.id,
				content: "Uncertain",
				revision: uncertain?.revision ?? 0,
				requestId: "attempt-3",
			}),
		).rejects.toThrow();
		expect(messages).toBe(2);
		if (!uncertain) throw new Error("Fixture lost owned identity");
		await client.call("standalone.retire", {
			id: session.id,
			revision: uncertain.revision,
		});
		expect(
			(await client.call("standalone.read", { id: session.id })).sessions[0]
				?.status,
		).toBe("closed");
		expect(
			(await client.call("state.read", {})).sessions.every(
				(row) => row.id !== Number(session.id),
			),
		).toBe(true);
		expect(creates).toBe(1);
	} finally {
		client?.close();
		host?.stop();
		native.stop(true);
		if (oldURL === undefined) delete process.env.AGENTIC_CODING_V2_OPENCODE_URL;
		else process.env.AGENTIC_CODING_V2_OPENCODE_URL = oldURL;
		if (oldToken === undefined)
			delete process.env.AGENTIC_CODING_V2_OPENCODE_TOKEN;
		else process.env.AGENTIC_CODING_V2_OPENCODE_TOKEN = oldToken;
	}
});
