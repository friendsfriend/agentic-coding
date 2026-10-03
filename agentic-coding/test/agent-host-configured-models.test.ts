// The durable model surfaces offer the configured providers' models, resolved in
// process (`agent-host/configured-models.ts`) — no `pi` executable and no model
// CLI: the bundled durable runtime needs neither to answer "what can I run".
import { describe, expect, test } from "bun:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import {
	configuredModelList,
	configuredModels,
	configuredProviderIds,
} from "../src/agent-host/configured-models.ts";

/** The faux provider's auth, replaced so the provider reports no usable
 * credential: the unconfigured half of a collection's providers. */
function unconfigured(
	provider: ReturnType<typeof fauxProvider>["provider"],
	id: string,
): typeof provider {
	return {
		...provider,
		id,
		auth: {
			check: async () => undefined,
			resolve: async () => undefined,
		},
	} as typeof provider;
}

/** A provider whose availability check rejects, like a credential store that
 * cannot be read: it must not take the whole list down with it. */
function failing(
	provider: ReturnType<typeof fauxProvider>["provider"],
	id: string,
): typeof provider {
	return {
		...provider,
		id,
		auth: {
			check: async () => {
				throw new Error("credential store unreadable");
			},
			resolve: async () => undefined,
		},
	} as typeof provider;
}

describe("configured models for the durable runtime", () => {
	test("offers every model of a configured provider and nothing of an unconfigured one", async () => {
		const faux = fauxProvider({
			provider: "configured",
			models: [{ id: "one" }, { id: "two" }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		models.setProvider(unconfigured(faux.provider, "unconfigured"));
		models.setProvider(failing(faux.provider, "failing"));

		// Availability is per provider: the answer is the provider ids, and only
		// those providers' models are enumerated.
		expect([...(await configuredProviderIds(models))].sort()).toEqual([
			"configured",
		]);
		expect((await configuredModels(models)).sort()).toEqual([
			"configured/one",
			"configured/two",
		]);
		expect(await configuredModelList(models)).toEqual([
			"configured/one",
			"configured/two",
		]);
	});

	test("an unconfigured provider's models are never even read", async () => {
		// The whole point of answering per provider: a provider the user has not
		// configured must cost nothing beyond its one availability check, so its
		// model list is never enumerated.
		const configuredFaux = fauxProvider({
			provider: "configured",
			models: [{ id: "one" }],
		});
		const unreadable = fauxProvider({
			provider: "unreadable",
			models: [{ id: "one" }],
		});
		let reads = 0;
		const models = createModels();
		models.setProvider(configuredFaux.provider);
		models.setProvider({
			...unreadable.provider,
			id: "unreadable",
			auth: {
				check: async () => undefined,
				resolve: async () => undefined,
			},
			getModels: () => {
				reads += 1;
				return unreadable.provider.getModels();
			},
		} as typeof unreadable.provider);

		expect(await configuredModelList(models)).toEqual(["configured/one"]);
		expect(reads).toBe(0);
	});

	test("reads availability from a collection's own providers, spawning nothing", async () => {
		// The durable path must answer without the `pi` executable: this runs with
		// an empty PATH, so any spawn would fail rather than silently fall back.
		const previous = process.env.PATH;
		process.env.PATH = "";
		try {
			const faux = fauxProvider({
				provider: "standalone",
				models: [{ id: "m" }],
			});
			const models = createModels();
			models.setProvider(faux.provider);
			expect([...(await configuredModels(models))]).toEqual(["standalone/m"]);
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
		}
	});

	test("an empty collection yields an empty list rather than throwing", async () => {
		expect(await configuredModelList(createModels())).toEqual([]);
	});
});
