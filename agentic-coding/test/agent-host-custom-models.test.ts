// BUG fix-custom-provider-models-in-pickers: the custom providers of pi's
// global `models.json` (e.g. the `eon` provider in `~/.pi/agent/models.json`)
// were missing from every pi-durable model list — the dashboard `/model` picker,
// the Settings agent-profile select — and the durable host could not resolve a
// run bound to `eon/<model>` at launch, even though workflow-start validation
// accepted the profile (it reads `models.json` itself).
//
// One collection now feeds all three consumers (`agent-host/configured-models.ts`
// `durableModels`): pi-ai's built-in providers with global pi's own
// `models.json` composed over them by pi's loader/composer. These tests drive it
// from fixture files in throwaway agent directories only — no network, no real
// `~/.pi`, and no real key: every fixture key is `test-key`-shaped.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
	configuredModelList,
	durableModels,
} from "../src/agent-host/configured-models.ts";
import { DurableHost, withDurableSession } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	assertModelAvailable,
	parseAgentsConfig,
	resolveProfile,
} from "../src/workflow/profiles.ts";

/** The fixture provider a user configures by hand: two models, no reachable
 * endpoint (loopback port 9 is the discard port and nothing listens there), so
 * an accidental request fails immediately instead of leaving the machine. */
const CUSTOM_PROVIDERS = {
	eon: {
		baseUrl: "http://127.0.0.1:9/v1",
		api: "anthropic-messages",
		apiKey: "test-key",
		models: [
			{
				id: "claude-5-sonnet",
				name: "Claude 5 Sonnet",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 200000,
				maxTokens: 64000,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			},
			{ id: "claude-5-haiku", contextWindow: 100000, maxTokens: 32000 },
		],
	},
};

interface Sandbox {
	/** The throwaway agent directory `PI_CODING_AGENT_DIR` points at. */
	readonly dir: string;
	restore(): void;
}

/** Point the process at a throwaway agent directory holding `models.json`
 * (`undefined` writes none), the way a user's `PI_CODING_AGENT_DIR` would. */
function agentDirSandbox(models: unknown): Sandbox {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-durable-models-json-"));
	if (models !== undefined) {
		fs.writeFileSync(
			path.join(dir, "models.json"),
			typeof models === "string" ? models : JSON.stringify(models),
		);
	}
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return {
		dir,
		restore: () => {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		},
	};
}

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function profileFor(model: string) {
	return resolveProfile(
		"durable",
		parseAgentsConfig({
			profiles: { durable: { runtime: "pi-durable", model } },
		}),
	);
}

/** Sorted provider ids, so a comparison does not depend on registration order. */
function providerIds(providers: readonly { id: string }[]): string[] {
	return providers.map((provider) => provider.id).sort();
}

describe("global pi models.json custom providers", () => {
	test("reach the durable collection and the Settings model list", async () => {
		const sandbox = agentDirSandbox({ providers: CUSTOM_PROVIDERS });
		try {
			// `PI_CODING_AGENT_DIR` is honoured, so this is the default resolution
			// a TUI or a host uses — no explicit path.
			const collection = await durableModels();
			expect(
				collection
					.getModels("eon")
					.map((model) => model.id)
					.sort(),
			).toEqual(["claude-5-haiku", "claude-5-sonnet"]);
			const list = await configuredModelList(collection);
			expect(list).toContain("eon/claude-5-sonnet");
			expect(list).toContain("eon/claude-5-haiku");
			// The model the run streams through: the api the file declares, with its
			// context window and output bound intact.
			const sonnet = collection.getModel("eon", "claude-5-sonnet");
			expect(sonnet?.api).toBe("anthropic-messages");
			expect(sonnet?.contextWindow).toBe(200000);
			expect(sonnet?.maxTokens).toBe(64000);
		} finally {
			sandbox.restore();
		}
	});

	test("the host logs a broken models.json once and still opens with the built-in providers", async () => {
		const sandbox = agentDirSandbox(
			'{"providers": {"eon": {"apiKey": "test-key", "models": [',
		);
		const dir = tempDir("agent-host-broken-models-json-");
		const lines: string[] = [];
		try {
			const host = await DurableHost.open({
				layout: hostLayout(dir),
				settings: {},
				globalAgentDir: dir,
				storage: new MemoryStorage(),
				log: (line) => lines.push(line),
			});
			try {
				const diagnostics = lines.filter((line) =>
					line.includes("models.json"),
				);
				expect(diagnostics).toHaveLength(1);
				expect(diagnostics[0]).not.toContain("test-key");
				// Opening is unaffected: the picker lists the built-in models.
				const catalog = await host.catalog();
				expect(catalog.models).not.toContain("eon/claude-5-sonnet");
			} finally {
				await host.shutdown();
			}
		} finally {
			sandbox.restore();
		}
	});

	test("appear in the host's /model picker with their context windows and resolve a run", async () => {
		const sandbox = agentDirSandbox({ providers: CUSTOM_PROVIDERS });
		const dir = tempDir("agent-host-custom-models-");
		// No `models` override: this is the production wiring, so the collection
		// under test is the one `DurableHost.open` builds for itself.
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
		});
		try {
			const catalog = await host.catalog();
			expect(catalog.models).toContain("eon/claude-5-sonnet");
			expect(catalog.models).toContain("eon/claude-5-haiku");
			expect(catalog.contextWindows["eon/claude-5-sonnet"]).toBe(200000);
			expect(catalog.contextWindows["eon/claude-5-haiku"]).toBe(100000);

			// A run bound to the custom model resolves in the collection the host
			// hands pi-durable: pi-durable resolves a run's ref with
			// `models.getModel(provider, modelId)`, and the host resolves the same
			// ref for its session window. An unknown ref resolves in neither, so
			// nothing but the model's own context window can produce this answer.
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='run-custom'\n");
			await host.ensureRun({
				runId: "run-custom",
				name: "worker-custom",
				cwd: dir,
				runEnvPath,
				toolPolicy: "default",
				model: "eon/claude-5-sonnet",
			});
			expect(host.referenceWindowForTest()).toBe(200000);
		} finally {
			await host.shutdown();
			sandbox.restore();
		}
	});

	test("an absent models.json adds nothing and reports nothing", async () => {
		const sandbox = agentDirSandbox(undefined);
		try {
			const diagnostics: string[] = [];
			const collection = await durableModels({
				onDiagnostic: (message) => diagnostics.push(message),
			});
			expect(diagnostics).toEqual([]);
			expect(providerIds(collection.getProviders())).toEqual(
				providerIds(builtinModels().getProviders()),
			);
		} finally {
			sandbox.restore();
		}
	});

	test("a syntax error leaves the built-in providers and reports one diagnostic without the file's content", async () => {
		// Truncated mid-key: a file a person pasted together by hand.
		const sandbox = agentDirSandbox(
			'{"providers": {"eon": {"apiKey": "test-key", "models": [',
		);
		try {
			const diagnostics: string[] = [];
			const collection = await durableModels({
				onDiagnostic: (message) => diagnostics.push(message),
			});
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toContain("models.json");
			// The diagnostic names the file, never its content and never a key.
			expect(diagnostics[0]).not.toContain("test-key");
			expect(diagnostics[0]).not.toContain("apiKey");
			expect(providerIds(collection.getProviders())).toEqual(
				providerIds(builtinModels().getProviders()),
			);
		} finally {
			sandbox.restore();
		}
	});

	test("a schema-invalid file leaves the built-in providers and reports one diagnostic without a key", async () => {
		const sandbox = agentDirSandbox({
			providers: {
				eon: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "anthropic-messages",
					apiKey: "sk-fixture-secret-value",
					models: "not-an-array",
				},
			},
		});
		try {
			const diagnostics: string[] = [];
			const collection = await durableModels({
				onDiagnostic: (message) => diagnostics.push(message),
			});
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toContain("models");
			expect(diagnostics[0]).not.toContain("sk-fixture-secret-value");
			expect(collection.getProvider("eon")).toBeUndefined();
			expect(providerIds(collection.getProviders())).toEqual(
				providerIds(builtinModels().getProviders()),
			);
		} finally {
			sandbox.restore();
		}
	});

	test("PI_CODING_AGENT_DIR decides which models.json is composed", async () => {
		const withModels = agentDirSandbox({ providers: CUSTOM_PROVIDERS });
		try {
			expect((await durableModels()).getProvider("eon")).toBeDefined();
		} finally {
			withModels.restore();
		}
		const withoutModels = agentDirSandbox(undefined);
		try {
			expect((await durableModels()).getProvider("eon")).toBeUndefined();
		} finally {
			withoutModels.restore();
		}
	});

	test("workflow-start validation and the durable collection agree for one file", async () => {
		const sandbox = agentDirSandbox({ providers: CUSTOM_PROVIDERS });
		try {
			const offered = (await durableModels())
				.getModels("eon")
				.map((model) => model.id)
				.sort();
			expect(offered).toEqual(["claude-5-haiku", "claude-5-sonnet"]);
			// Two readers of the same file: every model the collection offers is
			// accepted at workflow start, and a model it does not offer is refused
			// there instead of failing at launch.
			for (const id of offered)
				expect(() =>
					assertModelAvailable(profileFor(`eon/${id}`)),
				).not.toThrow();
			expect(() =>
				assertModelAvailable(profileFor("eon/not-in-the-file")),
			).toThrow(/unknown model/);
			expect(offered).not.toContain("not-in-the-file");
		} finally {
			sandbox.restore();
		}
	});

	test("a built-in provider id keeps pi's composition and the opencode-go session wrapper", async () => {
		// A `models.json` entry for a built-in provider: pi overlays the file on the
		// built-in provider (its own precedence for a colliding id — the built-in
		// models stay and take the configured base URL) rather than replacing it,
		// and the durable session-id wrapper still finds `opencode-go` to wrap.
		const sandbox = agentDirSandbox({
			providers: {
				"opencode-go": {
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "test-key",
				},
			},
		});
		try {
			const diagnostics: string[] = [];
			const collection = await durableModels({
				onDiagnostic: (message) => diagnostics.push(message),
			});
			expect(diagnostics).toEqual([]);
			const composed = collection.getProvider("opencode-go");
			expect(composed).toBeDefined();
			expect(composed?.getModels().length).toBeGreaterThan(0);
			expect(composed?.getModels()[0]?.baseUrl).toBe("http://127.0.0.1:9/v1");

			// Trap the composed provider's own stream: the wrapper has to reach it
			// with the pinned session id, exactly as it does for an untouched
			// built-in provider (`agent-host-session-id.test.ts`).
			const seen: Array<string | undefined> = [];
			collection.setProvider({
				...(composed as Provider),
				streamSimple: (_model, _context, options) => {
					seen.push((options as { sessionId?: string } | undefined)?.sessionId);
					return undefined as never;
				},
			} as Provider);
			withDurableSession(collection);
			collection
				.getProvider("opencode-go")
				?.streamSimple({} as never, {} as never, undefined);
			expect(seen).toHaveLength(1);
			expect(typeof seen[0]).toBe("string");
		} finally {
			sandbox.restore();
		}
	});
});
