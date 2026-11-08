import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	fauxAssistantMessage,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
afterEach(cleanup);
test("authenticated Pi abort keeps a cancelled attempt uncertain without publishing a reply or resending", async () => {
	const { config, fake } = await fixture();
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: path.join(config.stateDir, "fake-abort-model-cache"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	models.registerNativeProvider(fake.provider);
	const app = await Runtime.open(config, models, new MemoryStorage());
	apps.push(app);
	const repository = config.repositories[0];
	if (!repository) throw new Error("Missing fixture repository");
	const gate = Promise.withResolvers<void>();
	let entered = false;
	let observedAbort = false;
	fake.setResponses([
		fauxAssistantMessage("Earlier ready reply"),
		async (_context, options) => {
			if (!options?.signal)
				throw new Error("Missing native cancellation signal");
			options.signal.addEventListener(
				"abort",
				() => {
					observedAbort = true;
					gate.resolve();
				},
				{ once: true },
			);
			entered = true;
			await gate.promise;
			return fauxAssistantMessage("Do not publish this cancelled reply");
		},
	]);
	const host = serve(app, 0),
		client = new ClientConnection(host.client);
	client.connect();
	try {
		await eventually(
			() => Promise.resolve(client.status),
			(status) => status === "connected",
		);
		const session = await client.call("standalone.create", {
			mode: "pi",
			profile: "test",
			repository,
			title: "Cancel owned Pi",
		});
		const first = await client.call("standalone.send", {
			id: session.id,
			revision: session.revision,
			requestId: "abort-first",
			content: "Retain a prior reply",
		});
		const sending = client
			.call("standalone.send", {
				id: session.id,
				revision: first.revision,
				requestId: "abort-second",
				content: "Cancel this request",
			})
			.then(
				() => "ready",
				() => "uncertain",
			);
		await eventually(
			() => Promise.resolve(entered),
			(value) => value,
		);
		await client.call("standalone.abort", { id: session.id });
		expect(observedAbort).toBe(true);
		expect(await sending).toBe("uncertain");
		const retained = (
			await client.call("standalone.read", { id: session.id })
		).sessions.find((value) => value.id === session.id);
		expect(retained?.status).toBe("uncertain");
		expect(
			retained?.messages.filter((value) => value.role === "assistant"),
		).toEqual([{ role: "assistant", content: "Earlier ready reply" }]);
		await expect(
			client.call("standalone.send", {
				id: session.id,
				revision: retained?.revision ?? 0,
				requestId: "abort-second",
				content: "Cancel this request",
			}),
		).rejects.toThrow();
		await expect(
			client.call("standalone.abort", { id: session.id }),
		).rejects.toThrow();
		expect(fake.state.callCount).toBe(2);
	} finally {
		gate.resolve();
		client.close();
		host.stop();
	}
});
test("authenticated native Pi retains SDK identity/context without tools or project discovery and refuses changed private sources", async () => {
	const { config, fake } = await fixture();
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: path.join(config.stateDir, "fake-model-cache"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	models.registerNativeProvider(fake.provider);
	const app = await Runtime.open(config, models, new MemoryStorage());
	apps.push(app);
	const repository = config.repositories[0];
	if (!repository) throw new Error("Missing fixture repository");
	fs.writeFileSync(
		path.join(repository, "AGENTS.md"),
		"DO_NOT_DISCOVER_PRIVATE_NATIVE_FIXTURE",
	);
	fake.setResponses([
		(context) => {
			expect(
				context.messages.flatMap((message) =>
					message.role === "system" ? (message.toolsAdded ?? []) : [],
				),
			).toEqual([]);
			expect(JSON.stringify(context.messages)).not.toContain(
				"DO_NOT_DISCOVER_PRIVATE_NATIVE_FIXTURE",
			);
			return fauxAssistantMessage("Native Pi answer");
		},
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("Native Pi answer");
			return fauxAssistantMessage("Retained context answer");
		},
	]);
	const host = serve(app, 0),
		client = new ClientConnection(host.client);
	client.connect();
	try {
		await eventually(
			() => Promise.resolve(client.status),
			(status) => status === "connected",
		);
		const session = await client.call("standalone.create", {
			mode: "pi",
			profile: "test",
			repository,
			title: "Private native SDK",
		});
		const first = await client.call("standalone.send", {
			id: session.id,
			revision: session.revision,
			requestId: "pi-first",
			content: "Hello native Pi",
		});
		expect(first.messages.at(-1)?.content).toBe("Native Pi answer");
		const second = await client.call("standalone.send", {
			id: session.id,
			revision: first.revision,
			requestId: "pi-second",
			content: "Use retained context",
		});
		expect(second.messages.at(-1)?.content).toBe("Retained context answer");
		expect(fake.state.callCount).toBe(2);
		const directory = path.join(config.stateDir, "standalone-pi", session.id),
			file = fs.readdirSync(directory)[0];
		if (!file) throw new Error("Native SDK file unavailable");
		const source = path.join(directory, file);
		const entries = fs
			.readFileSync(source, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(entries[0].type).toBe("session");
		expect(
			entries.filter(
				(entry) => entry.type === "message" && entry.message.role === "user",
			),
		).toHaveLength(2);
		expect(
			entries.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			),
		).toHaveLength(2);
		expect(fs.statSync(source).mode & 0o077).toBe(0);
		expect(JSON.stringify(second)).not.toContain(directory);
		fs.appendFileSync(source, "\n");
		await expect(
			client.call("standalone.send", {
				id: session.id,
				revision: second.revision,
				requestId: "pi-changed",
				content: "Do not adopt changed native source",
			}),
		).rejects.toThrow();
		expect(fake.state.callCount).toBe(2);
		expect(
			(await client.call("standalone.read", { id: session.id })).sessions[0]
				?.status,
		).toBe("uncertain");
	} finally {
		client.close();
		host.stop();
	}
});
