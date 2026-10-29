import fs from "node:fs";
import path from "node:path";
import { ensureHostRunning, HostClient } from "../../agent-host/client.ts";
import { hostLayout } from "../../agent-host/layout.ts";
import { orchestratorHostEnv } from "../../agent-host/orchestrator-session.ts";
import {
	type ScheduledEnvelope,
	schedulingDigest,
} from "../../agent-host/scheduled-admission.ts";
import { configRootEnv } from "../../config-root.ts";
import type {
	Job,
	Occurrence,
	TargetReceipt,
} from "../../contracts/scheduling.ts";
import { SchedulingError } from "../../contracts/scheduling.ts";
import { selfExecEntry } from "../../self-exec.ts";
import { writeAgentRunEnv } from "../../workflow/run-env.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	trySecureFileLock,
} from "../../workflow/secure-fs.ts";
import {
	SchedulingDestinationUnavailable,
	SchedulingInfrastructureError,
	type SchedulingTargetAdapter,
} from "./adapters.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(
		[
			"git",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-C",
			cwd,
			...args,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [output, error, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0)
		throw new SchedulingError(
			"invalid-input",
			`Standalone repository/worktree validation failed: ${error.slice(0, 512)}`,
		);
	return output.trim();
}
function prompt(value: Occurrence): string {
	return `Scheduled standalone execution ${value.id}\nNominal due: ${new Date(value.nominalDue).toISOString()}\nOriginal instruction: ${value.job.originalInstruction}\nReason: ${value.job.reason}\nReferences: ${value.job.references.join("; ")}\nReport destination: ${value.job.reportingDestination}\nPermission policy: ${value.job.target.kind === "standalone" ? value.job.target.policy : "invalid"}. Scheduling grants no additional authorization.\n\nTask:\n${value.job.task}`;
}
export interface StandaloneAdapterOptions {
	readonly startHost?: (runtimeDir: string, cwd: string) => Promise<HostClient>;
	readonly catalog?: () => Promise<{
		models: readonly string[];
		thinkingLevels: readonly string[];
	}>;
	readonly configDir?: string;
	/** Boundary injection for deterministic slow-preparation fixtures. */
	readonly prepareWorktree?: (
		repository: string,
		branch: string,
		cwd: string,
		base: string,
	) => Promise<void>;
}
async function nativeCatalog() {
	const [{ configuredModelList }, { DurableHost }] = await Promise.all([
		import("../../agent-host/configured-models.ts"),
		import("../../agent-host/host.ts"),
	]);
	return {
		models: await configuredModelList(),
		thinkingLevels: DurableHost.THINKING_LEVELS,
	};
}
export function standaloneAdapter(
	root: string,
	options: StandaloneAdapterOptions = {},
): SchedulingTargetAdapter {
	function runtime(value: Occurrence): string {
		if (!/^[a-zA-Z0-9_-]{1,120}$/.test(value.id))
			throw new SchedulingError(
				"invalid-input",
				"Invalid occurrence identity.",
			);
		return path.join(root, "agents", value.id);
	}
	async function client(runtimeDir: string, cwd: string) {
		if (options.startHost) return options.startHost(runtimeDir, cwd);
		const layout = hostLayout(runtimeDir),
			entry = selfExecEntry();
		await ensureHostRunning(layout, {
			command: process.execPath,
			args: [
				...(entry ? [entry] : []),
				"agent",
				"host",
				"--workflow-dir",
				runtimeDir,
			],
			cwd,
			env: orchestratorHostEnv({
				...process.env,
				...(options.configDir ? configRootEnv(options.configDir) : {}),
			}),
		});
		return new HostClient(layout.socketPath);
	}
	async function validate(job: Job) {
		const target = job.target;
		if (target.kind !== "standalone")
			throw new SchedulingError(
				"invalid-input",
				"Expected a standalone target.",
			);
		const catalog = await (options.catalog ?? nativeCatalog)();
		if (!catalog.models.includes(target.model))
			throw new SchedulingDestinationUnavailable(
				"Standalone model is not currently configured and available.",
			);
		if (target.thinking && !catalog.thinkingLevels.includes(target.thinking))
			throw new SchedulingError(
				"invalid-input",
				"Standalone thinking level is not supported by the native runtime.",
			);
		const repository = fs.realpathSync(target.repository);
		if ((await git(repository, "rev-parse", "--show-toplevel")) !== repository)
			throw new SchedulingError(
				"invalid-input",
				"Standalone repository must be its canonical root.",
			);
		await git(
			repository,
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${target.baseBranch}^{commit}`,
		);
		return { ...job, target: { ...target, repository } };
	}
	function runInput(value: Occurrence, cwd: string, runtimeDir: string) {
		const target = value.job.target;
		if (target.kind !== "standalone")
			throw new SchedulingError(
				"invalid-input",
				"Expected a standalone target.",
			);
		return {
			runId: `schedule-${value.id}`,
			cwd,
			runEnvPath: writeAgentRunEnv({
				cwd,
				runDirectory: runtimeDir,
				runId: `schedule-${value.id}`,
				environment: options.configDir ? configRootEnv(options.configDir) : {},
			}),
			name: value.job.name,
			toolPolicy: target.policy,
			model: target.model,
			...(target.thinking ? { thinking: target.thinking } : {}),
		};
	}
	function envelope(
		value: Occurrence,
		agent: NonNullable<TargetReceipt["agent"]>,
	): ScheduledEnvelope {
		const text = prompt(value);
		return {
			occurrenceId: value.id,
			text,
			digest: schedulingDigest(text),
			expectedHostId: agent.hostId,
			expectedConversationId: agent.conversationId,
			runId: agent.runId,
		};
	}
	function decorate(
		value: Occurrence,
		native: TargetReceipt,
		agent: NonNullable<TargetReceipt["agent"]>,
	): TargetReceipt {
		const receipt = { ...native, agent };
		if (native.state === "succeeded" || native.state === "execution-failed") {
			const temp = `${agent.outputPath}.${crypto.randomUUID()}.tmp`;
			fs.writeFileSync(
				temp,
				JSON.stringify({
					occurrenceId: value.id,
					state: native.state,
					hostSocket: agent.hostSocket,
					runId: agent.runId,
					conversationId: agent.conversationId,
					submission: native.submission,
					output: native.result ?? null,
				}),
				{ mode: 0o600, flag: "wx" },
			);
			fs.renameSync(temp, agent.outputPath);
		}
		return receipt;
	}
	async function existing(value: Occurrence) {
		const agent = value.receipt?.agent;
		if (!agent)
			throw new SchedulingError(
				"conflict",
				"Pinned standalone receipt required.",
			);
		const runtimeDir = runtime(value),
			layout = hostLayout(runtimeDir),
			cwd = path.join(runtimeDir, "worktree");
		if (
			agent.hostSocket !== layout.socketPath ||
			!fs.existsSync(layout.storagePath) ||
			!fs.existsSync(cwd)
		)
			throw new SchedulingDestinationUnavailable(
				"Pinned standalone store/worktree unavailable; no replacement was created.",
			);
		const host = await client(runtimeDir, cwd);
		if ((await host.scheduledIdentity()) !== agent.hostId)
			throw new SchedulingDestinationUnavailable(
				"Standalone host store identity changed.",
			);
		await host.recoverRun({
			...runInput(value, cwd, runtimeDir),
			expectedConversationId: agent.conversationId,
		});
		return { host, agent };
	}
	return {
		resolve: validate,
		async reserve(value) {
			const job = await validate(value.job);
			if (job.target.kind !== "standalone")
				throw new SchedulingError(
					"invalid-input",
					"Expected standalone target.",
				);
			const runtimeDir = runtime(value),
				cwd = path.join(runtimeDir, "worktree"),
				branch = `schedule/${value.id}`;
			fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
			const directory = openSecureDirectory(runtimeDir, root, false);
			let ownership: number | undefined;
			try {
				ownership = trySecureFileLock(directory, "preparation.lock");
			} finally {
				closeSecureDirectory(directory);
			}
			if (ownership === undefined)
				throw new SchedulingInfrastructureError(
					"Standalone preparation is still owned by another dispatcher.",
				);
			try {
				if (!fs.existsSync(cwd))
					if (options.prepareWorktree)
						await options.prepareWorktree(
							job.target.repository,
							branch,
							cwd,
							job.target.baseBranch,
						);
					else
						await git(
							job.target.repository,
							"worktree",
							"add",
							"-b",
							branch,
							cwd,
							job.target.baseBranch,
						);
				const actualRoot = fs.realpathSync(
					await git(cwd, "rev-parse", "--show-toplevel"),
				);
				const actualBranch = await git(cwd, "branch", "--show-current");
				const nativeCommon = fs.realpathSync(
						path.resolve(cwd, await git(cwd, "rev-parse", "--git-common-dir")),
					),
					sourceCommon = fs.realpathSync(
						path.resolve(
							job.target.repository,
							await git(job.target.repository, "rev-parse", "--git-common-dir"),
						),
					);
				if (
					actualRoot !== fs.realpathSync(cwd) ||
					actualBranch !== branch ||
					nativeCommon !== sourceCommon
				)
					throw new SchedulingDestinationUnavailable(
						"Standalone worktree ownership mismatch.",
					);
				const host = await client(runtimeDir, cwd),
					input = runInput(value, cwd, runtimeDir),
					binding = await host.ensureRun(input);
				const agent = {
					hostSocket: hostLayout(runtimeDir).socketPath,
					hostId: await host.scheduledIdentity(),
					runId: input.runId,
					conversationId: binding.conversationId,
					outputPath: path.join(runtimeDir, "result.json"),
				};
				const response = await host.scheduledAdmission({
					operation: "reserve",
					envelope: envelope(value, agent),
					fence: value.fence,
				});
				return decorate(value, response.receipt, agent);
			} finally {
				fs.closeSync(ownership);
			}
		},
		async activate(value) {
			if (value.admittedAt === undefined)
				throw new SchedulingError(
					"conflict",
					"Committed standalone activation authority required.",
				);
			const { host, agent } = await existing(value);
			return decorate(
				value,
				(
					await host.scheduledAdmission({
						operation: "activate",
						envelope: envelope(value, agent),
						fence: value.fence,
					})
				).receipt,
				agent,
			);
		},
		async query(value) {
			try {
				const { host, agent } = await existing(value);
				return decorate(
					value,
					(
						await host.scheduledAdmission({
							operation: "query",
							envelope: envelope(value, agent),
							fence: value.fence,
						})
					).receipt,
					agent,
				);
			} catch (error) {
				if (
					error instanceof SchedulingDestinationUnavailable ||
					error instanceof SchedulingError
				)
					throw error;
				throw new SchedulingInfrastructureError(
					"Standalone host temporarily unavailable.",
				);
			}
		},
	};
}
