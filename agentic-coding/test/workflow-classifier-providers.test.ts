// Pluggable classifier providers + the managed local sidecar
// (introduce-local-model-support-for-classification). Covers the provider
// catalog defaults, `[agents.classifier]` validation and the `set-classifier`
// mutation, the pin-at-start decision, the opt-in install state machine, the
// `laya-local` wire target, fail-open behavior when the local provider is
// unavailable, and the identical answer parsing of a local response.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import {
	selectedClassifierProvider,
	startSelectedLocalClassifier,
} from "../src/server/classifier.ts";
import {
	agentConfigRevision,
	applyAgentsMutation,
} from "../src/server/config.ts";
import { providerChoice } from "../src/tui/settings/AgentPresetsView.tsx";
import {
	CLASSIFIER_PROVIDER_SPECS,
	DEFAULT_CLASSIFIER_PROVIDER,
	LAYA_LOCAL_MODEL,
	LAYA_LOCAL_PROVIDER,
	OPENCODE_ZEN_PROVIDER,
} from "../src/workflow/classifier-providers.ts";
import {
	classifierProvider,
	classifierProviders,
	invokeRoutingClassifier,
	layaLocalProvider,
	resolveClassifierBinding,
	routingRequest,
} from "../src/workflow/classifier-runner.ts";
import { effectRunnerTest } from "../src/workflow/effect-runner.ts";
import {
	LAYA_LOCAL_PORT,
	LAYA_PACKAGE_ROOT_VAR,
	LayaLocalClassifier,
	type LayaLocalDependencies,
	layaLocalClassifier,
	layaLocalPaths,
	realLayaLocalDependencies,
	resolveLayaPackageRoot,
	setLayaLocalClassifier,
} from "../src/workflow/laya-local.ts";
import {
	parseAgentsConfig,
	resolveClassifierProvider,
} from "../src/workflow/profiles.ts";

const temps: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classifier-provider-"));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	setLayaLocalClassifier();
	for (const dir of temps.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

/** A classifier over fake deps: no model, no network, no spawned process. */
function fakeClassifier(
	installDir: string,
	overrides: Partial<LayaLocalDependencies> = {},
): LayaLocalClassifier {
	return new LayaLocalClassifier({
		paths: () => ({
			installDir,
			cacheDir: installDir,
			backend: "native",
			port: 4571,
		}),
		acquire: async () => ({
			path: path.join(installDir, "model.onnx"),
			bytes: 42,
		}),
		totalBytes: () => 324_125_608,
		start: async () => ({
			url: "http://127.0.0.1:4321",
			stop: async () => {},
		}),
		...overrides,
	});
}

describe("server classifier status", () => {
	test("an unreadable configuration falls back to the hosted provider", () => {
		const dir = tempDir();
		const file = path.join(dir, "config.json");
		fs.writeFileSync(file, "{ not json");
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			expect(selectedClassifierProvider()).toBe(DEFAULT_CLASSIFIER_PROVIDER);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	});
});

describe("classifier provider catalog", () => {
	test("the two built-ins are the only selectable providers", () => {
		expect(CLASSIFIER_PROVIDER_SPECS.map((spec) => spec.id)).toEqual([
			OPENCODE_ZEN_PROVIDER,
			LAYA_LOCAL_PROVIDER,
		]);
		// No id, label or description may surface the separate `opencode-go` plan.
		expect(JSON.stringify(CLASSIFIER_PROVIDER_SPECS)).not.toContain(
			"opencode-go",
		);
	});

	test("an absent configuration selects the hosted provider", () => {
		const agents = parseAgentsConfig({ profiles: {} });
		expect(agents.classifier).toBeUndefined();
		expect(resolveClassifierProvider(agents)).toBe(DEFAULT_CLASSIFIER_PROVIDER);
		expect(DEFAULT_CLASSIFIER_PROVIDER).toBe(OPENCODE_ZEN_PROVIDER);
	});

	test("an unknown provider id is rejected with the registered list", () => {
		expect(() =>
			parseAgentsConfig({
				profiles: {},
				classifier: { provider: "opencode-go" },
			}),
		).toThrow(/unknown classifier provider "opencode-go"; expected one of/);
		// A prototype name is not a provider either.
		expect(() =>
			parseAgentsConfig({ profiles: {}, classifier: { provider: "toString" } }),
		).toThrow(/unknown classifier provider/);
	});

	test("a recognized provider is preserved with its options", () => {
		const agents = parseAgentsConfig({
			profiles: {},
			classifier: { provider: LAYA_LOCAL_PROVIDER, options: { threads: 4 } },
		});
		expect(agents.classifier).toEqual({
			provider: LAYA_LOCAL_PROVIDER,
			options: { threads: 4 },
		});
		expect(resolveClassifierProvider(agents)).toBe(LAYA_LOCAL_PROVIDER);
	});
});

describe("pinned classifier provider", () => {
	test("the pinned id wins over the current configuration", () => {
		// A mid-run edit to `[agents.classifier]` must not switch the endpoint of
		// a workflow that already pinned its provider.
		const agents = parseAgentsConfig({
			profiles: {},
			classifier: { provider: OPENCODE_ZEN_PROVIDER },
		});
		expect(resolveClassifierBinding(agents, LAYA_LOCAL_PROVIDER).provider).toBe(
			LAYA_LOCAL_PROVIDER,
		);
		expect(resolveClassifierBinding(agents, undefined).provider).toBe(
			OPENCODE_ZEN_PROVIDER,
		);
	});

	test("an unreadable pinned value falls back to the configuration", () => {
		const snapshot = {
			metadata: { classifier: "opencode-go" },
		} as unknown as WorkflowSnapshot;
		expect(effectRunnerTest.pinnedClassifierProvider(snapshot)).toBeUndefined();
		expect(
			effectRunnerTest.pinnedClassifierProvider({
				metadata: { classifier: LAYA_LOCAL_PROVIDER },
			} as unknown as WorkflowSnapshot),
		).toBe(LAYA_LOCAL_PROVIDER);
	});
});

describe("set-classifier mutation", () => {
	function withConfig<T>(content: object, run: () => T): T {
		const dir = tempDir();
		const file = path.join(dir, "config.json");
		fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			return run();
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	}

	test("round-trips the provider and preserves unrelated keys", () => {
		withConfig(
			{
				agents: { default_profile: "a", profiles: { a: { runtime: "pi" } } },
				workflow: { keep: true },
			},
			() => {
				const before = agentConfigRevision();
				applyAgentsMutation({
					kind: "set-classifier",
					classifier: { provider: LAYA_LOCAL_PROVIDER },
				});
				expect(agentConfigRevision()).not.toBe(before);
				const file = JSON.parse(
					fs.readFileSync(process.env.HERDR_WORKFLOW_CONFIG as string, "utf8"),
				) as Record<string, unknown>;
				expect((file.agents as Record<string, unknown>).classifier).toEqual({
					provider: LAYA_LOCAL_PROVIDER,
				});
				expect(file.workflow).toEqual({ keep: true });
				expect(parseAgentsConfig(file.agents).classifier?.provider).toBe(
					LAYA_LOCAL_PROVIDER,
				);
			},
		);
	});

	test("a provider switch preserves the rest of the classifier table", () => {
		withConfig(
			{
				agents: {
					profiles: {},
					classifier: {
						provider: OPENCODE_ZEN_PROVIDER,
						options: { threads: 4 },
						futureKey: 1,
					},
				},
			},
			() => {
				applyAgentsMutation({
					kind: "set-classifier",
					classifier: { provider: LAYA_LOCAL_PROVIDER },
				});
				const file = JSON.parse(
					fs.readFileSync(process.env.HERDR_WORKFLOW_CONFIG as string, "utf8"),
				) as { agents: { classifier: Record<string, unknown> } };
				// A hand-tuned options table (and any unknown key) survives the switch.
				expect(file.agents.classifier).toEqual({
					provider: LAYA_LOCAL_PROVIDER,
					options: { threads: 4 },
					futureKey: 1,
				});
			},
		);
	});

	test("a non-table options value is refused before any write", () => {
		withConfig({ agents: { profiles: {} } }, () => {
			const file = process.env.HERDR_WORKFLOW_CONFIG as string;
			const before = fs.readFileSync(file, "utf8");
			expect(() =>
				applyAgentsMutation({
					kind: "set-classifier",
					classifier: {
						provider: LAYA_LOCAL_PROVIDER,
						options: "native" as unknown as Record<string, unknown>,
					},
				}),
			).toThrow(/agents\.classifier\.options must be a table/);
			// The document is untouched, so a malformed write cannot make `[agents]`
			// unloadable.
			expect(fs.readFileSync(file, "utf8")).toBe(before);
		});
	});

	test("a non-table options value is rejected on read", () => {
		expect(() =>
			parseAgentsConfig({
				profiles: {},
				classifier: { provider: LAYA_LOCAL_PROVIDER, options: "native" },
			}),
		).toThrow(/agents.classifier.options must be a table/);
	});

	test("an unknown provider is refused before any write", () => {
		withConfig({ agents: { profiles: {} } }, () => {
			const before = agentConfigRevision();
			expect(() =>
				applyAgentsMutation({
					kind: "set-classifier",
					classifier: { provider: "opencode-go" },
				}),
			).toThrow(/unknown classifier provider/);
			expect(agentConfigRevision()).toBe(before);
		});
	});
});

describe("laya-local install state machine", () => {
	test("an explicit install acquires, starts, and reports ready", async () => {
		const dir = tempDir();
		const classifier = fakeClassifier(dir);
		expect(classifier.status()).toMatchObject({
			installed: false,
			running: false,
			job: { phase: "idle" },
		});
		const job = await classifier.install();
		expect(job.phase).toBe("ready");
		expect(job.totalBytes).toBe(324_125_608);
		expect(classifier.status()).toMatchObject({
			installed: true,
			running: true,
			job: { phase: "ready" },
		});
		expect(classifier.systemOneUrl()).toBe(
			"http://127.0.0.1:4321/v1/systemone",
		);
	});

	test("a fresh process never installs without an explicit call", async () => {
		const dir = tempDir();
		const classifier = fakeClassifier(dir);
		// `ensureStarted` is the provider's start hook: it may only start an
		// already-installed model, never acquire one.
		await expect(classifier.ensureStarted()).rejects.toThrow(/not installed/);
		expect(classifier.status().installed).toBe(false);
		expect(classifier.status().job?.phase).toBe("idle");
	});

	test("cancelling an in-flight install settles as cancelled and keeps files", async () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "model.onnx"), "already-installed");
		const classifier = fakeClassifier(dir, {
			acquire: ({ signal, onPhase }) =>
				new Promise((_, reject) => {
					onPhase({ phase: "acquiring" });
					signal.addEventListener(
						"abort",
						() => {
							const error = new Error("cancelled");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				}),
		});
		const pending = classifier.install();
		classifier.cancel();
		const job = await pending;
		expect(job.phase).toBe("cancelled");
		// The previously installed model is untouched.
		expect(fs.readFileSync(path.join(dir, "model.onnx"), "utf8")).toBe(
			"already-installed",
		);
		expect(classifier.status().installed).toBe(true);
	});

	test("a failed install reports the error and leaves the model intact", async () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "model.onnx"), "previous");
		const classifier = fakeClassifier(dir, {
			acquire: async () => {
				throw new Error("checksum mismatch");
			},
		});
		const job = await classifier.install();
		expect(job).toMatchObject({ phase: "failed", detail: "checksum mismatch" });
		expect(classifier.status().error).toContain("checksum mismatch");
		expect(fs.readFileSync(path.join(dir, "model.onnx"), "utf8")).toBe(
			"previous",
		);
	});

	test("concurrent starts spawn exactly one sidecar", async () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "model.onnx"), "model");
		let starts = 0;
		const classifier = fakeClassifier(dir, {
			start: async () => {
				starts += 1;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { url: "http://127.0.0.1:4321", stop: async () => {} };
			},
		});
		await Promise.all([
			classifier.ensureStarted(),
			classifier.ensureStarted(),
			classifier.ensureStarted(),
		]);
		// The check-then-act window this guards produced three `laya-serve`
		// processes, each holding the ~324 MB model.
		expect(starts).toBe(1);
	});

	test("concurrent starts share one verification, not only one spawn", async () => {
		// The expensive front half runs before the spawn's single-flight point, so
		// without a whole-operation guard every concurrent launch would hash the
		// model again.
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "model.onnx"), "model");
		let verifies = 0;
		let starts = 0;
		const classifier = fakeClassifier(dir, {
			verify: async () => {
				verifies += 1;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { ok: true };
			},
			start: async () => {
				starts += 1;
				return { url: "http://127.0.0.1:4321", stop: async () => {} };
			},
		});
		await Promise.all([
			classifier.ensureStarted(),
			classifier.ensureStarted(),
			classifier.ensureStarted(),
		]);
		expect(verifies).toBe(1);
		expect(starts).toBe(1);
	});

	test("stop does not resolve while a start is still verifying", async () => {
		// A start that has not reached the spawn yet is invisible to the spawn's
		// own single-flight, so `stop()` has to wait for the whole operation —
		// otherwise the spawn lands after shutdown reported it had released the
		// sidecar.
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "model.onnx"), "model");
		let verifying: (() => void) | undefined;
		const inVerify = new Promise<void>((resolve) => {
			verifying = resolve;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let stops = 0;
		const classifier = fakeClassifier(dir, {
			verify: async () => {
				verifying?.();
				await gate;
				return { ok: true };
			},
			start: async () => ({
				url: "http://127.0.0.1:4321",
				stop: async () => {
					stops += 1;
				},
			}),
		});
		const pending = classifier.ensureStarted().catch(() => {});
		await inVerify;
		let stopped = false;
		const stopping = classifier.stop().then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stopped).toBe(false);
		release?.();
		await Promise.all([pending, stopping]);
		// The superseded spawn is stopped and never published.
		expect(classifier.status().running).toBe(false);
		expect(stops).toBe(1);
	});

	test("stop releases the sidecar exactly once", async () => {
		const dir = tempDir();
		let stops = 0;
		const classifier = fakeClassifier(dir, {
			start: async () => ({
				url: "http://127.0.0.1:4321",
				stop: async () => {
					stops += 1;
				},
			}),
		});
		await classifier.install();
		expect(classifier.status().running).toBe(true);
		await classifier.stop();
		expect(classifier.status().running).toBe(false);
		expect(stops).toBe(1);
	});

	test("a stop that lands while the sidecar starts leaves nothing running", async () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "model.onnx"), "model");
		let stops = 0;
		let release: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			release = resolve;
		});
		const classifier = fakeClassifier(dir, {
			start: async () => {
				await started;
				return {
					url: "http://127.0.0.1:4321",
					stop: async () => {
						stops += 1;
					},
				};
			},
		});
		const pending = classifier.ensureStarted();
		const stopped = classifier.stop();
		release?.();
		await Promise.all([pending.catch(() => {}), stopped]);
		// The superseded spawn is stopped and never published.
		expect(classifier.status().running).toBe(false);
		expect(stops).toBe(1);
	});
});

describe("laya package discovery", () => {
	test("an explicit override names the package when the executable cannot find it", () => {
		// The case this exists for: a compiled binary copied out of the tree its
		// `node_modules` live in, where neither the executable's neighbourhood nor
		// module resolution can reach `laya-system-one`.
		const elsewhere = tempDir();
		const packageDir = tempDir();
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "laya-system-one" }),
		);
		expect(
			resolveLayaPackageRoot({
				execPath: path.join(elsewhere, "agentic-coding"),
				cwd: elsewhere,
				env: { [LAYA_PACKAGE_ROOT_VAR]: packageDir },
				resolve: () => path.join(elsewhere, "missing.js"),
			}),
		).toBe(packageDir);
	});

	test("an override that is not the package is ignored, not trusted", () => {
		// The override must not become a way to point the process at an arbitrary
		// directory claiming to be the classifier runtime.
		const elsewhere = tempDir();
		const impostor = tempDir();
		fs.writeFileSync(
			path.join(impostor, "package.json"),
			JSON.stringify({ name: "not-the-classifier" }),
		);
		expect(
			resolveLayaPackageRoot({
				execPath: path.join(elsewhere, "agentic-coding"),
				cwd: elsewhere,
				env: { [LAYA_PACKAGE_ROOT_VAR]: impostor },
				resolve: () => path.join(elsewhere, "missing.js"),
			}),
		).toBeUndefined();
	});

	test("the executable's own tree still wins when nothing is configured", () => {
		const root = tempDir();
		const install = path.join(root, "app");
		const packageDir = path.join(install, "node_modules", "laya-system-one");
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "laya-system-one" }),
		);
		expect(
			resolveLayaPackageRoot({
				execPath: path.join(install, "dist", "agentic-coding"),
				cwd: tempDir(),
				env: {},
				resolve: () => path.join(root, "missing.js"),
			}),
		).toBe(packageDir);
	});
});

describe("provider choice predicate", () => {
	test("an uninstalled local provider routes through the install modal", () => {
		// The persistence decision itself is covered by the component tests in
		// test/app/agentPresetsView.test.tsx; this pins only the predicate.
		expect(providerChoice(LAYA_LOCAL_PROVIDER, false)).toEqual({
			action: "install",
		});
		expect(providerChoice(LAYA_LOCAL_PROVIDER, true)).toEqual({
			action: "persist",
		});
		expect(providerChoice(OPENCODE_ZEN_PROVIDER, false)).toEqual({
			action: "persist",
		});
	});
});

describe("provider wire targets", () => {
	test("opencode-zen keeps the hosted endpoint, key and bare model", () => {
		const previous = process.env.OPENCODE_API_KEY;
		process.env.OPENCODE_API_KEY = "secret-key";
		try {
			const target = classifierProvider(OPENCODE_ZEN_PROVIDER).resolve({
				model: "opencode/jev-1.13-free",
			});
			expect(target.url).toBe("https://opencode.ai/zen/v1/systemone");
			expect(target.headers.Authorization).toBe("Bearer secret-key");
			expect(target.model).toBe("jev-1.13-free");
		} finally {
			if (previous === undefined) delete process.env.OPENCODE_API_KEY;
			else process.env.OPENCODE_API_KEY = previous;
		}
	});

	test("laya-local binds localhost, sends no hosted key, and keeps no prefix", async () => {
		const dir = tempDir();
		const classifier = fakeClassifier(dir);
		setLayaLocalClassifier(classifier);
		await classifier.install();
		const target = layaLocalProvider().resolve({
			model: "opencode/jev-1.13-free",
		});
		expect(target.url).toBe("http://127.0.0.1:4321/v1/systemone");
		// The sidecar binds 127.0.0.1 only and carries no hosted credential.
		expect(new URL(target.url).hostname).toBe("127.0.0.1");
		expect(target.headers.Authorization).toBeUndefined();
		// The local server is asked for the provider's own local model id, never
		// the hosted `opencode/…` one.
		expect(target.model).toBe(LAYA_LOCAL_MODEL);
		expect(target.model).not.toContain("opencode/");
	});

	test("laya-local refuses to resolve before the sidecar is running", () => {
		const dir = tempDir();
		setLayaLocalClassifier(fakeClassifier(dir));
		expect(() => layaLocalProvider().resolve({ model: "anything" })).toThrow(
			/not running/,
		);
	});

	test("a response parses identically through either provider", async () => {
		// A real loopback server speaks the same System One envelope a local or a
		// hosted provider returns; the point is that the transport does not change
		// how the envelope is parsed.
		const envelope = {
			model: LAYA_LOCAL_MODEL,
			answers: {
				core: {
					choice: "quick",
					confidence: 0.91,
					probabilities: { quick: 0.91, deep: 0.09 },
				},
				triage: { type: "noul", noul: 0.4 },
			},
			usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json(envelope),
		});
		try {
			const dir = tempDir();
			const classifier = fakeClassifier(dir, {
				start: async () => ({
					url: `http://127.0.0.1:${server.port}`,
					stop: async () => {},
				}),
			});
			setLayaLocalClassifier(classifier);
			await classifier.install();
			const answers = await Effect.runPromise(
				invokeRoutingClassifier(
					[
						{
							stepId: "core",
							mode: "single",
							entries: [{ label: "quick", profile: "base", default: true }],
						},
					],
					{ provider: LAYA_LOCAL_PROVIDER, model: "ignored" },
					{ task: "t", changeId: "c", artifacts: [] },
				),
			);
			expect(answers.answers).toEqual({
				core: {
					type: "choice",
					choice: "quick",
					confidence: 0.91,
					probabilities: { quick: 0.91, deep: 0.09 },
				},
			});
		} finally {
			await server.stop(true);
		}
	});

	test("a routing request resolves its transport through the provider", async () => {
		const dir = tempDir();
		const classifier = fakeClassifier(dir);
		setLayaLocalClassifier(classifier);
		await classifier.install();
		const request = routingRequest(
			[
				{
					stepId: "core.plan",
					mode: "single",
					entries: [{ label: "quick", profile: "base", default: true }],
				},
			],
			LAYA_LOCAL_PROVIDER,
			"opencode/jev-1.13-free",
			"state",
		);
		expect(request.target.url).toBe("http://127.0.0.1:4321/v1/systemone");
		expect(request.target.headers.Authorization).toBeUndefined();
		expect(request.target.model).toBe(LAYA_LOCAL_MODEL);
		expect(Object.keys(request.body.questions)).toEqual(["core.plan"]);
	});

	test("the local provider is registered alongside the hosted one", () => {
		expect(Object.keys(classifierProviders()).sort()).toEqual([
			LAYA_LOCAL_PROVIDER,
			OPENCODE_ZEN_PROVIDER,
		]);
		expect(classifierProvider(LAYA_LOCAL_PROVIDER).label).toBe(
			"Offline, on this machine",
		);
	});
});

describe("fail-open with an unavailable local provider", () => {
	/** A real git checkout: triage collects the changed-file manifest before it
	 * reaches the provider, so the state must be readable to exercise that
	 * path at all. */
	function gitRoot(): string {
		const root = tempDir();
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		fs.writeFileSync(path.join(root, "a.txt"), "one\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync(
			"git",
			["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-qm", "base"],
			{ cwd: root },
		);
		return root;
	}

	function snapshotWith(metadata: Record<string, unknown>): WorkflowSnapshot {
		return {
			workflowId: "wf",
			revision: 1,
			currentStep: "core.triage-route",
			metadata: {
				repository: "",
				worktree: gitRoot(),
				baseCommit: "HEAD",
				changeId: "",
				task: "t",
				classifier: LAYA_LOCAL_PROVIDER,
				...metadata,
			},
			step: { results: [] },
		} as unknown as WorkflowSnapshot;
	}

	test("triage fails open when the local model is not installed", async () => {
		setLayaLocalClassifier(fakeClassifier(tempDir()));
		const result = await Effect.runPromise(
			effectRunnerTest.triageClassification(
				snapshotWith({}),
				"openspec",
				() => {},
			),
		);
		expect(result.integration).toBe("triage");
		expect(result.failOpen).toBe(true);
		expect(result.roles).toBeUndefined();
		expect(result.reason).toContain("laya-local");
	});

	test("routing fails open to the pool defaults when the local model is missing", async () => {
		setLayaLocalClassifier(fakeClassifier(tempDir()));
		const result = await Effect.runPromise(
			effectRunnerTest.routingClassification(
				() =>
					invokeRoutingClassifier(
						[
							{
								stepId: "core.implementation",
								mode: "single",
								entries: [{ label: "quick", profile: "base", default: true }],
							},
						],
						{
							provider: LAYA_LOCAL_PROVIDER,
							model: "opencode/jev-1.13-free",
						},
						{ task: "t", changeId: "c", artifacts: [] },
					),
				"apply",
			),
		);
		expect(result.integration).toBe("routing");
		expect(result.phase).toBe("apply");
		expect(result.failOpen).toBe(true);
		expect(result.reason).toContain("laya-local");
		// An empty answer map is exactly what makes the reducer keep each step's
		// pinned pool default instead of blocking the run.
		expect(result.answers).toEqual({});
	});

	test("an automatic gate forces the run when the local model is missing", async () => {
		setLayaLocalClassifier(fakeClassifier(tempDir()));
		const snapshot = snapshotWith({
			gatePolicies: {
				planApproval: "auto",
				verification: "always",
				developerReview: "always",
				wiki: "always",
			},
		});
		snapshot.currentStep = "core.plan-gate";
		const result = await Effect.runPromise(
			effectRunnerTest.gateClassification(snapshot, "planApproval", () => {}),
		);
		expect(result.decision).toBe("run");
		expect(result.forced).toBe(true);
		expect(result.policy).toBe("auto");
		expect(result.reason).toContain("laya-local");
	});

	test("the default local model id is a local one, never a hosted prefix", () => {
		expect(LAYA_LOCAL_MODEL).toBe("laya-system-one");
	});
});

// A pane's `AGENTIC_JEV` outlives the engine that wrote it, so the sidecar's
// port has to survive an engine restart: an ephemeral port leaves the recorded
// URL permanently dead and every in-session `ask_jev` call failing with
// "fetch failed".
describe("laya-local sidecar port", () => {
	test("binds a fixed loopback port, not an ephemeral one", () => {
		const paths = layaLocalPaths({}, "/tmp/root");
		expect(paths.port).toBe(LAYA_LOCAL_PORT);
		expect(LAYA_LOCAL_PORT).toBeGreaterThan(0);
	});

	test("LAYA_PORT overrides it and a non-port value falls back", () => {
		expect(layaLocalPaths({ LAYA_PORT: "4610" }, "/tmp/root").port).toBe(4610);
		expect(layaLocalPaths({ LAYA_PORT: "nope" }, "/tmp/root").port).toBe(
			LAYA_LOCAL_PORT,
		);
		expect(layaLocalPaths({ LAYA_PORT: "70000" }, "/tmp/root").port).toBe(
			LAYA_LOCAL_PORT,
		);
	});

	test("selecting the local provider starts it and switching away never stops it", async () => {
		let starts = 0;
		let stops = 0;
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "model.onnx"), "model");
		setLayaLocalClassifier(
			fakeClassifier(dir, {
				start: async () => {
					starts += 1;
					return {
						url: "http://127.0.0.1:4321",
						stop: async () => {
							stops += 1;
						},
					};
				},
			}),
		);
		startSelectedLocalClassifier(OPENCODE_ZEN_PROVIDER);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(starts).toBe(0);
		// Awaited, not fire-and-forget: the shell's splash holds its step until
		// the model is actually serving, so no polling is needed here.
		await startSelectedLocalClassifier(LAYA_LOCAL_PROVIDER);
		expect(starts).toBe(1);
		// Switching away must leave the standalone service warm: panes already
		// hold its endpoint.
		startSelectedLocalClassifier(OPENCODE_ZEN_PROVIDER);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stops).toBe(0);
		expect(layaLocalClassifier().endpoint()).toBe("http://127.0.0.1:4321");
	});

	test("a binary that exits fails the start instead of waiting out the timeout", async () => {
		// A free port claimed and released, so this exercises the spawn and not
		// adoption of whatever the developer's own machine has on 4571.
		const free = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(""),
		});
		const port = free.port;
		await free.stop(true);
		if (port === undefined) throw new Error("the probe server has no port");
		const started = Date.now();
		await expect(
			realLayaLocalDependencies({}, "/tmp/root").start({
				paths: {
					installDir: "/tmp/none",
					cacheDir: "/tmp/none",
					backend: "native",
					port,
					explicitBinary: "/nonexistent/laya-serve",
				},
				modelPath: "/tmp/none/model.onnx",
			}),
		).rejects.toThrow(/exited before it answered/);
		expect(Date.now() - started).toBeLessThan(30_000);
	});

	test("a start adopts a sidecar already answering on the port", async () => {
		// The probe server stands in for the sidecar a previous engine started:
		// same /health envelope the dependency serves.
		const existing = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ status: "ok" }),
		});
		const port = existing.port;
		if (port === undefined) throw new Error("the probe server has no port");
		try {
			const handle = await realLayaLocalDependencies({}, "/tmp/root").start({
				paths: {
					installDir: "/tmp/none",
					cacheDir: "/tmp/none",
					backend: "native",
					port,
				},
				modelPath: "/tmp/none/model.onnx",
			});
			expect(handle.url).toBe(`http://127.0.0.1:${port}`);
			// Adopted, never ours to stop: a running engine's sidecar must survive.
			await handle.stop();
			expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
		} finally {
			await existing.stop(true);
		}
	});
});
