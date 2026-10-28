// Delivery push credential preflight (efficiency backlog item 16).
//
// The unit cases pin the module's pure decisions (which lines count as a
// positive authentication failure, which remotes are local or absent, what the
// ssh command and environment become, and that no credential is ever printed).
// The verdict cases run the real check against a stand-in `ssh` on PATH, and
// the handler cases drive the real `delivery.push` handler through a real
// `EffectRunner.drain`, so "blocked once, retried after the fix" and "a check
// that could not reach the remote did not block the push" are observed as
// workflow state and as real transfers into a bare repository.
//
// The stand-in `ssh` answers git's transport command itself for the check
// (upload-pack) and delegates to the real git server for the push
// (receive-pack), so a mode can separate "the check failed" from "the push
// worked" — which is exactly the distinction the preflight must not confuse.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { WorkflowExecutionSettings } from "../src/contracts/workflow.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import type { TelemetryEnvelope } from "../src/workflow/observability.ts";
import {
	isGitRemoteUrl,
	isLocalPathRemote,
	type PushPreflightInput,
	pushAuthFailureNote,
	pushAuthFailureSignal,
	pushPreflightEffect,
	pushPreflightEnv,
	pushPreflightSshCommand,
	redactRemoteLabel,
} from "../src/workflow/push-preflight.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
} from "./support/git-fixture.ts";
import { enterFixtureStep } from "./support/workflow-recovery-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

/** Stand-in ssh: it reads its mode from a file next to itself (the delivery
 * push's environment is minimal, so an environment variable would not reach
 * it), logs every invocation, answers the check itself when the mode says so,
 * and otherwise execs the real git server for the bare repository. */
const STUB_SSH = `#!/bin/sh
dir=$(cd "$(dirname "$0")" && pwd)
mode=$(cat "$dir/mode" 2>/dev/null || echo allow)
bare=$(cat "$dir/bare")
cmd=""
for arg in "$@"; do
	case "$arg" in
		*git-upload-pack* | *git-receive-pack*) cmd="$arg" ;;
	esac
done
deny_credentials() {
	printf 'git@fake.invalid: Permission denied (publickey).\\n' >&2
	printf 'fatal: Could not read from remote repository.\\n' >&2
	exit 255
}
printf '%s\\n' "$*" >> "$dir/invocations.log"
case "$cmd" in
	*git-upload-pack*)
		case "$mode" in
			deny) deny_credentials ;;
			unreachable)
				printf 'ssh: Could not resolve hostname fake.invalid: nodename nor servname provided, or not known\\n' >&2
				printf 'fatal: Could not read from remote repository.\\n' >&2
				exit 255
				;;
			slow) sleep 30 ;;
		esac
		;;
	*git-receive-pack*)
		case "$mode" in deny) deny_credentials ;; esac
		;;
esac
case "$cmd" in
	*git-upload-pack*) exec "$(git --exec-path)/git-upload-pack" "$bare" ;;
	*git-receive-pack*) exec "$(git --exec-path)/git-receive-pack" "$bare" ;;
esac
exit 1
`;

type StubMode = "allow" | "deny" | "unreachable" | "slow";

interface Stub {
	readonly dir: string;
	readonly executable: string;
	mode(value: StubMode): void;
	/** Every ssh invocation, one line of arguments each. */
	invocations(): string[];
}

function createStub(bare: string): Stub {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-preflight-stub-"));
	const executable = path.join(dir, "ssh");
	fs.writeFileSync(executable, STUB_SSH, { mode: 0o755 });
	fs.writeFileSync(path.join(dir, "bare"), `${bare}\n`);
	const stub: Stub = {
		dir,
		executable,
		mode: (value) =>
			fs.writeFileSync(path.join(dir, "mode"), `${value}\n`, { mode: 0o600 }),
		invocations: () => {
			try {
				return fs
					.readFileSync(path.join(dir, "invocations.log"), "utf8")
					.split("\n")
					.filter((line) => line !== "");
			} catch {
				return [];
			}
		},
	};
	stub.mode("allow");
	return stub;
}

/** Run `body` with the stand-in ssh first on PATH (which the push's minimal
 * environment inherits) and as GIT_SSH_COMMAND (which the check inherits),
 * restoring both afterwards. */
async function withStub<T>(stub: Stub, body: () => Promise<T>): Promise<T> {
	const previousPath = process.env.PATH;
	const previousCommand = process.env.GIT_SSH_COMMAND;
	process.env.PATH = `${stub.dir}${path.delimiter}${previousPath ?? ""}`;
	process.env.GIT_SSH_COMMAND = stub.executable;
	try {
		return await body();
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCommand === undefined) delete process.env.GIT_SSH_COMMAND;
		else process.env.GIT_SSH_COMMAND = previousCommand;
	}
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository with a bare remote beside it. */
function fixture(label: string): { repo: string; bare: string } {
	const repo = createTempRepoFixture(`${label}-`, {
		files: { "README.md": "x\n", ".gitignore": ".herdr-workflow\n" },
	});
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-bare-`));
	git(bare, ["init", "-q", "-b", "main", "--bare"]);
	return { repo, bare };
}

function disposable(...dirs: string[]): void {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

function preflight(
	input: Omit<PushPreflightInput, "interactive"> &
		Partial<Pick<PushPreflightInput, "interactive">>,
) {
	return Effect.runPromise(pushPreflightEffect(input));
}

function profile() {
	return {
		name: "test",
		runtime: "pi-durable" as const,
		executable: "sh",
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"] as const,
		digest: "test-profile",
	};
}

function deliverySettings(remote: string): WorkflowExecutionSettings {
	return {
		remote,
		prTool: null,
		provenance: { source: "user", files: [] },
	};
}

/** Start an in-repository `no-openspec` workflow pinned to delivery settings. */
function startWorkflow(
	engine: WorkflowEngine,
	repo: string,
	workflowId: string,
	remote: string,
) {
	const started = engine.start({
		repo,
		workflowId,
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: git(repo, ["rev-parse", "HEAD"]),
			task: "task",
			executionSettings: deliverySettings(remote),
		},
		routing: {
			defaultProfile: profile().name,
			routes: [
				{ stepId: "core.implementation", role: "worker", profile: profile() },
			],
		},
	});
	// Seed a test-only review fixture, then use the real developer approval.
	// Production recovery deliberately cannot jump to this gate.
	const reviewed = enterFixtureStep(
		engine,
		repo,
		started.view.workflowId,
		"core.developer-review",
	).view;
	engine.dispatch(repo, {
		type: "developer.action",
		workflowId: reviewed.workflowId,
		revision: reviewed.revision,
		actionId: "approve-review",
	});
	const arrived = engine.status(repo, started.view.workflowId);
	if (arrived.currentStep.id !== "core.delivery")
		throw new Error(
			`preflight test expected core.delivery, reached ${arrived.currentStep.id}`,
		);
	return started;
}

interface DeliveryHarness {
	readonly repo: string;
	readonly bare: string;
	readonly stub: Stub;
	readonly engine: WorkflowEngine;
	readonly workflowId: string;
	readonly events: TelemetryEnvelope[];
	/** Drain only the delivery effects: an unrelated pending effect of the
	 * repository's earlier step must not be executed by this test. */
	drainDelivery(kind: "delivery.commit" | "delivery.push"): Promise<number>;
	preflightVerdicts(): TelemetryEnvelope[];
	view(): ReturnType<WorkflowEngine["status"]>;
}

function harness(
	label: string,
	options: { interactive?: boolean } = {},
): DeliveryHarness {
	const { repo, bare } = fixture(label);
	const remote = "ssh://git@fake.invalid/org/repo.git";
	git(repo, ["remote", "add", "origin", remote]);
	const stub = createStub(bare);
	const registry = registerBuiltins();
	const engine = new WorkflowEngine(registry);
	const started = startWorkflow(engine, repo, label, "origin");
	const events: TelemetryEnvelope[] = [];
	const handlers = agentEffectHandlers(repo, engine, {
		registry,
		adapters: new Map(),
		telemetry: (_directory, envelope) => {
			events.push(envelope);
		},
		...(options.interactive ? { credentialPrompt: async () => "" } : {}),
	});
	return {
		repo,
		bare,
		stub,
		engine,
		workflowId: started.view.workflowId,
		events,
		drainDelivery: (kind) =>
			new EffectRunner(repo, engine, handlers, { claimKind: kind }).drain(
				1,
				5_000,
			),
		preflightVerdicts: () =>
			events.filter((event) => event.event === "delivery.push_preflight"),
		view: () => engine.status(repo, started.view.workflowId),
	};
}

function requireEffect(
	view: ReturnType<WorkflowEngine["status"]>,
	kind: string,
) {
	const effect = view.effects.find((item) => item.kind === kind);
	if (!effect) throw new Error(`no ${kind} effect in the workflow`);
	return effect;
}

test("only a recognized authentication failure counts as a positive verdict", () => {
	// ssh and the two credential-bearing https servers.
	expect(
		pushAuthFailureSignal(
			"git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
		),
	).toContain("Permission denied (publickey)");
	expect(
		pushAuthFailureSignal(
			"remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
		),
	).toContain("Invalid username or password");
	expect(
		pushAuthFailureSignal(
			"remote: HTTP Basic: Access denied. The provided password or token is incorrect",
		),
	).toContain("Access denied");
	// Everything a check cannot interpret must stay inconclusive: a network
	// failure, a missing repository, and git's own "no prompt available" (which
	// an interactive push answers with the credential popup).
	for (const text of [
		"ssh: connect to host github.com port 22: Operation timed out",
		"ssh: Could not resolve hostname github.com: Name or service not known",
		"ssh: connect to host github.com port 22: Connection refused",
		"fatal: '/tmp/x.git' does not appear to be a git repository",
		"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
		"fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404",
	])
		expect(pushAuthFailureSignal(text)).toBeUndefined();
	// The reported line is bounded, so a hostile remote cannot inflate a note.
	expect(
		pushAuthFailureSignal(`Authentication failed ${"x".repeat(5_000)}`),
	).toHaveLength(301);
});

test("local-path remotes are recognized as needing no credential", () => {
	for (const value of [
		"/tmp/x.git",
		"../x.git",
		"./x",
		"~/x.git",
		"file:///x.git",
	])
		expect(isLocalPathRemote(value)).toBe(true);
	for (const value of [
		"ssh://git@host/org/repo.git",
		"https://host/org/repo.git",
		"git@host:org/repo.git",
		"git://host/repo.git",
	])
		expect(isLocalPathRemote(value)).toBe(false);
	// A configured remote *name* is not a URL, so it is resolved (and reported
	// as "no remote") rather than checked as one.
	expect(isGitRemoteUrl("origin")).toBe(false);
	expect(isGitRemoteUrl("git@host:org/repo.git")).toBe(true);
});

test("a reported remote and note never carry a credential", () => {
	expect(redactRemoteLabel("https://user:s3cret@host/org/repo.git")).toBe(
		"https://user:***@host/org/repo.git",
	);
	// An ssh remote's user is not a secret, and a bare URL is unchanged.
	expect(redactRemoteLabel("git@host:org/repo.git")).toBe(
		"git@host:org/repo.git",
	);
	expect(
		redactRemoteLabel("https://oauth2:ghp_abcdefghijklmnopqrstuv@host/o/r.git"),
	).not.toContain("ghp_abcdefghijklmnopqrstuv");
	const note = pushAuthFailureNote({
		remote: "https://user:s3cret@host/org/repo.git",
		label: "https://user:s3cret@host/org/repo.git",
		signal: "git@host: Permission denied (publickey).",
		source: "preflight",
	});
	expect(note).not.toContain("s3cret");
	expect(note).toContain("https://user:***@host/org/repo.git");
	expect(note).toContain("Permission denied (publickey)");
	expect(note).toContain("the push was not attempted");
	expect(note).toContain("not retried unchanged");
	expect(note).toContain("ssh-add");
	expect(
		pushAuthFailureNote({
			remote: "origin",
			label: "ssh://git@fake.invalid/org/repo.git",
			signal: "Authentication failed for 'https://h/'",
			source: "push",
		}),
	).toContain("the push did not land");
});

test("the check's ssh command and environment can never prompt", () => {
	const order = pushPreflightSshCommand(
		{ GIT_SSH_COMMAND: "/usr/bin/mine -i /key", GIT_SSH: "/usr/bin/legacy" },
		"/usr/bin/configured",
	);
	expect(order).toBe("/usr/bin/mine -i /key -o BatchMode=yes");
	expect(pushPreflightSshCommand({ GIT_SSH: "/usr/bin/legacy" }, "")).toBe(
		"/usr/bin/legacy -o BatchMode=yes",
	);
	expect(pushPreflightSshCommand({}, "/usr/bin/configured")).toBe(
		"/usr/bin/configured -o BatchMode=yes",
	);
	expect(pushPreflightSshCommand({}, undefined)).toBe("ssh -o BatchMode=yes");
	const env = pushPreflightEnv(
		{
			PATH: "/usr/bin",
			GIT_ASKPASS: "/shim/askpass",
			SSH_ASKPASS: "/shim/askpass",
			SSH_ASKPASS_REQUIRE: "force",
			AGENTIC_CODING_ASKPASS_DIR: "/shim",
			UNSET: undefined,
			GIT_TERMINAL_PROMPT: "1",
		},
		"ssh -o BatchMode=yes",
	);
	expect(env.PATH).toBe("/usr/bin");
	expect(env.GIT_ASKPASS).toBeUndefined();
	expect(env.SSH_ASKPASS).toBeUndefined();
	expect(env.SSH_ASKPASS_REQUIRE).toBeUndefined();
	expect(env.AGENTIC_CODING_ASKPASS_DIR).toBeUndefined();
	expect(env.UNSET).toBeUndefined();
	expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
	expect(env.GIT_ALLOW_PROTOCOL).toBe("https:ssh:git");
});

test("the check blocks on refused credentials and stays inconclusive otherwise", async () => {
	const { repo, bare } = fixture("preflight-verdicts");
	const stub = createStub(bare);
	git(repo, [
		"remote",
		"add",
		"sshorigin",
		"ssh://git@fake.invalid/org/repo.git",
	]);
	try {
		await withStub(stub, async () => {
			stub.mode("deny");
			const denied = await preflight({ cwd: repo, remote: "sshorigin" });
			expect(denied.outcome).toBe("auth-failed");
			expect(denied.detail).toContain("Permission denied (publickey)");
			expect(denied.label).toBe("ssh://git@fake.invalid/org/repo.git");

			stub.mode("unreachable");
			const unreachable = await preflight({ cwd: repo, remote: "sshorigin" });
			expect(unreachable.outcome).toBe("inconclusive");
			expect(unreachable.detail).toContain("Could not resolve hostname");

			stub.mode("allow");
			const accepted = await preflight({ cwd: repo, remote: "sshorigin" });
			expect(accepted.outcome).toBe("ok");
			expect(accepted.detail).toBeUndefined();

			// A check that ran out of time is inconclusive, not a block: the push
			// must still be attempted. (Injected timeout: the production one is
			// long enough that no test should ever wait for it.)
			stub.mode("slow");
			const startedAt = Date.now();
			const timedOut = await preflight({
				cwd: repo,
				remote: "sshorigin",
				timeoutMs: 300,
			});
			expect(timedOut.outcome).toBe("inconclusive");
			expect(timedOut.detail).toContain("timed out");
			expect(Date.now() - startedAt).toBeLessThan(5_000);
		});
	} finally {
		disposable(repo, bare, stub.dir);
	}
});

test("the check is skipped where it could not say anything true", async () => {
	const { repo, bare } = fixture("preflight-skips");
	const stub = createStub(bare);
	git(repo, ["remote", "add", "localrepo", bare]);
	git(repo, [
		"remote",
		"add",
		"sshorigin",
		"ssh://git@fake.invalid/org/repo.git",
	]);
	try {
		await withStub(stub, async () => {
			// A remote the push reads as a local file needs no credential.
			const local = await preflight({ cwd: repo, remote: "localrepo" });
			expect(local.outcome).toBe("skipped-local");
			expect(local.detail).toBeUndefined();
			// A name this repository does not have needs no check either: the push
			// reports the missing remote itself.
			const absent = await preflight({ cwd: repo, remote: "nosuchremote" });
			expect(absent.outcome).toBe("skipped-no-remote");
			// A push that may ask the developer for a credential is left to that
			// prompt: a non-interactive verdict is not evidence about it.
			const interactive = await preflight({
				cwd: repo,
				remote: "sshorigin",
				interactive: true,
			});
			expect(interactive.outcome).toBe("skipped-interactive");
			// None of the three reached the network, which is the point of the
			// skip: no ssh process was started at all.
			expect(stub.invocations()).toEqual([]);
		});
	} finally {
		disposable(repo, bare, stub.dir);
	}
});

test("a push blocked by the check is retried once the credential is fixed", async () => {
	const h = harness("preflight-block");
	try {
		await withStub(h.stub, async () => {
			h.stub.mode("deny");
			await h.drainDelivery("delivery.commit");
			await h.drainDelivery("delivery.push");

			const blocked = h.view();
			const push = requireEffect(blocked, "delivery.push");
			// One attempt, one attention entry: the effect is not retried
			// unchanged, and the note says what to fix.
			expect(push.status).toBe("failed");
			expect(push.attempts).toBe(1);
			expect(push.lastError).toContain("could not authenticate");
			expect(push.lastError).toContain("fake.invalid");
			expect(push.lastError).toContain("remote origin");
			expect(push.lastError).toContain("Permission denied (publickey)");
			expect(push.lastError).toContain("ssh-add");
			expect(
				blocked.health.attention.filter((note) =>
					note.includes("delivery.push"),
				),
			).toHaveLength(1);
			// The push itself never ran: the check was the only thing that spoke
			// to the remote.
			expect(h.stub.invocations().length).toBeGreaterThan(0);
			expect(
				h.stub.invocations().every((line) => line.includes("git-upload-pack")),
			).toBe(true);
			expect(() =>
				git(h.bare, ["rev-parse", "--verify", "refs/heads/main"]),
			).toThrow();
			const verdicts = h.preflightVerdicts();
			expect(verdicts).toHaveLength(1);
			expect(verdicts[0]?.["herdr.delivery.push.preflight"]).toBe(
				"auth-failed",
			);
			expect(verdicts[0]?.["herdr.delivery.push.source"]).toBe("preflight");
			expect(verdicts[0]?.["herdr.delivery.push.remote"]).toBe(
				"ssh://git@fake.invalid/org/repo.git",
			);
			expect(verdicts[0]?.effectId).toBe(push.id);
			expect(verdicts[0]?.outcome).toBe("error");

			// The developer unlocks the key and retries the delivery push.
			h.stub.mode("allow");
			h.engine.dispatch(h.repo, {
				type: "developer.action",
				workflowId: h.workflowId,
				revision: blocked.revision,
				actionId: `retry-effect:${push.id}`,
			});
			await h.drainDelivery("delivery.push");
			const retried = h.view();
			expect(requireEffect(retried, "delivery.push").status).toBe("completed");
			expect(retried.health.attention).toEqual([]);
			expect(
				h.stub.invocations().some((line) => line.includes("git-receive-pack")),
			).toBe(true);
			expect(git(h.bare, ["rev-parse", "refs/heads/main"])).toBe(
				git(h.repo, ["rev-parse", "HEAD"]),
			);
		});
	} finally {
		disposable(h.repo, h.bare, h.stub.dir);
	}
});

test("a check that could not reach the remote does not block the push", async () => {
	const h = harness("preflight-unreachable");
	try {
		await withStub(h.stub, async () => {
			// The check cannot resolve the host; the push itself is served by the
			// stand-in ssh, so a blocked push here would be the preflight's fault.
			h.stub.mode("unreachable");
			await h.drainDelivery("delivery.commit");
			await h.drainDelivery("delivery.push");

			const view = h.view();
			expect(requireEffect(view, "delivery.push").status).toBe("completed");
			expect(view.health.attention).toEqual([]);
			expect(git(h.bare, ["rev-parse", "refs/heads/main"])).toBe(
				git(h.repo, ["rev-parse", "HEAD"]),
			);
			const verdicts = h.preflightVerdicts();
			expect(verdicts).toHaveLength(1);
			expect(verdicts[0]?.["herdr.delivery.push.preflight"]).toBe(
				"inconclusive",
			);
			expect(verdicts[0]?.outcome).toBe("ok");
		});
	} finally {
		disposable(h.repo, h.bare, h.stub.dir);
	}
});

test("a push the check left to a credential prompt blocks once when it fails", async () => {
	// The dashboard's push attaches a credential prompt, so the check is
	// skipped and the push runs; a push that then fails to authenticate must
	// still block once instead of retrying the identical failure.
	const h = harness("preflight-interactive", { interactive: true });
	try {
		await withStub(h.stub, async () => {
			h.stub.mode("deny");
			await h.drainDelivery("delivery.commit");
			await h.drainDelivery("delivery.push");

			const view = h.view();
			const push = requireEffect(view, "delivery.push");
			expect(push.status).toBe("failed");
			expect(push.attempts).toBe(1);
			expect(push.lastError).toContain("could not authenticate");
			expect(push.lastError).toContain("the push did not land");
			expect(push.lastError).toContain("Permission denied (publickey)");
			// The push was attempted (the check was not consulted), so the remote
			// saw the receive-pack request.
			expect(
				h.stub.invocations().some((line) => line.includes("git-receive-pack")),
			).toBe(true);
			const verdicts = h.preflightVerdicts();
			expect(
				verdicts.map((event) => event["herdr.delivery.push.source"]),
			).toEqual(["preflight", "push"]);
			expect(verdicts[0]?.["herdr.delivery.push.preflight"]).toBe(
				"skipped-interactive",
			);
			expect(verdicts[1]?.["herdr.delivery.push.preflight"]).toBe(
				"auth-failed",
			);
			expect(verdicts[1]?.outcome).toBe("error");
		});
	} finally {
		disposable(h.repo, h.bare, h.stub.dir);
	}
});

test("a local remote is skipped rather than blocked", async () => {
	// The production push refuses a `file` transport outright (the same
	// GIT_ALLOW_PROTOCOL the preflight uses), so what this case proves is that
	// the check did not turn that into a credential block: the effect is left to
	// the push's own retry policy.
	const { repo, bare } = fixture("preflight-local-handler");
	const registry = registerBuiltins();
	const engine = new WorkflowEngine(registry);
	git(repo, ["remote", "add", "origin", bare]);
	const started = startWorkflow(engine, repo, "preflight-local", "origin");
	const events: TelemetryEnvelope[] = [];
	const handlers = agentEffectHandlers(repo, engine, {
		registry,
		adapters: new Map(),
		telemetry: (_directory, envelope) => {
			events.push(envelope);
		},
	});
	try {
		await new EffectRunner(repo, engine, handlers, {
			claimKind: "delivery.commit",
		}).drain(1, 5_000);
		await new EffectRunner(repo, engine, handlers, {
			claimKind: "delivery.push",
		}).drain(1, 5_000);
		const view = engine.status(repo, started.view.workflowId);
		const push = requireEffect(view, "delivery.push");
		expect(push.status).not.toBe("failed");
		expect(push.lastError ?? "").not.toContain("could not authenticate");
		const verdicts = events.filter(
			(event) => event.event === "delivery.push_preflight",
		);
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0]?.["herdr.delivery.push.preflight"]).toBe(
			"skipped-local",
		);
	} finally {
		disposable(repo, bare);
	}
});
