// Test doubles for the Git/Clock/TraceExporter seams, plus a tmp-repo helper.
//
// ponytail: real git in a tmp dir beats mocking diff output; upgrade to a pure
// fake only if git-in-CI proves flaky.
import { execFileSync } from "node:child_process";
import type { Context } from "../src/workflow/effects.ts";
import { createRepoFixture } from "./support/git-fixture.ts";

export const DEFAULT_CONFIG = {
	models: {
		worker_default: "test/worker",
		verifier: "test/verifier",
		usability_verifier: "test/usability",
		verifier_fallback: "test/verifier-fallback",
		archive: "test/archive",
		git: "test/git",
		planner: "test/planner",
		triage: "test/triage",
	},
	thinking: {
		worker_default: "high",
		verifier: "high",
		verifier_lite: "medium",
		planner: "high",
		triage: "high",
		archive: "high",
	},
	workflow: {
		max_verification_rounds: 6,
		remote: "origin",
		branch_prefix: "feature/",
		base_branch: "origin/HEAD",
		worktree_directory: "~/.herdr/worktrees",
	},
	telemetry: { capture_content: false },
	ui: { theme: "catppuccin", selection_height: 10 },
	plugins: {},
};

export class FakeGit {
	run(args: string[], cwd: string): string {
		try {
			return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		} catch (error) {
			const procError = error as { stderr?: Uint8Array; stdout?: Uint8Array };
			const detail = (
				procError.stderr?.toString() ||
				procError.stdout?.toString() ||
				"command failed"
			).trim();
			throw new Error(`git ${args.join(" ")}: ${detail}`);
		}
	}
}

/** Fixed/monotone: `sleep` advances virtual time so timeout logic is deterministic and fast. */
export class FakeClock {
	private currentNow: Date;
	private monotonicSeconds: number;
	private timeSeconds: number;

	constructor(start = 1_700_000_000.0) {
		this.currentNow = new Date("2024-01-01T00:00:00Z");
		this.monotonicSeconds = start;
		this.timeSeconds = start;
	}

	now(): Date {
		return this.currentNow;
	}

	monotonic(): number {
		return this.monotonicSeconds;
	}

	time(): number {
		return this.timeSeconds;
	}

	timeNs(): bigint {
		return BigInt(Math.round(this.timeSeconds * 1_000_000_000));
	}

	async sleep(seconds: number): Promise<void> {
		this.advance(seconds);
	}

	advance(seconds: number): void {
		this.monotonicSeconds += seconds;
		this.timeSeconds += seconds;
		this.currentNow = new Date(this.currentNow.getTime() + seconds * 1000);
	}
}

export class NoopExporter {
	export(_record: unknown): void {
		/* no-op */
	}
}

export function makeContext(overrides: Partial<Context> = {}): Context {
	return {
		config: overrides.config ?? structuredClone(DEFAULT_CONFIG),
		git: overrides.git ?? new FakeGit(),
		clock: overrides.clock ?? new FakeClock(),
		exporter: overrides.exporter ?? new NoopExporter(),
	};
}

/** Init a git repo with an OpenSpec project and one committed base file. */
export function initRepo(dir: string): string {
	return createRepoFixture(dir, {
		files: {
			"README.md": "# test\n",
			"openspec/config.yaml": "name: test\n",
		},
		excludeWorkflowState: true,
	});
}
