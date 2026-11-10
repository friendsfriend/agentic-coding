import { defineTask } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { digest } from "../config.ts";
import { git, prepareWorkspace } from "../git.ts";
import { waitForReview } from "../reviews.ts";
import { Catalog, decode, type Review, type TaskInfo } from "../state.ts";
import { environmentApproval } from "./approval.ts";
import {
	type operatorInfrastructureLifetime,
	operatorInfrastructurePlans,
	validateLifetime,
} from "./lifetime.ts";
import type { Environments } from "./manager.ts";
import type { Plan } from "./model.ts";
import type { Action, Selection } from "./selection.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
} from "./state.ts";

export type OperatorAction = Selection & {
	apps: string[];
	action: Action;
	requestId: string;
	baseRef?: string;
	workspaceMode?: "checkout" | "worktree";
	lifetime?: typeof operatorInfrastructureLifetime;
};
type Input = {
	createdAt: number;
	request: OperatorAction;
	repository: string;
	baseCommit: string;
};
type ActiveCheckpoint<P extends string> = {
	phase: P;
	owner: TaskInfo;
	plans: Plan[];
	snapshot: string;
};
type Checkpoint =
	| { phase: "prepare" }
	| ActiveCheckpoint<"review">
	| ActiveCheckpoint<"execute">
	| ActiveCheckpoint<"held">;

export function operatorOwner(
	id: number,
	input: Input,
	workspace = "",
): TaskInfo {
	return {
		id,
		kind: "operator-environment",
		baseCommit: input.baseCommit,
		policy: "workspace-write",
		topicId: "environments",
		skill: `environment ${input.request.action}`,
		profile: "operator (no model)",
		repository: input.repository,
		workspace,
		relatedTo: null,
		createdAt: input.createdAt,
		reported: true,
	};
}

/** Native lifetime and exact human review; no model, agent or process adoption. */
export function createOperatorTask(config: Config, manager: Environments) {
	return defineTask<Input, Checkpoint, string>({
		name: "v2.environment-operator",
		version: 1,
		initial: () => ({ phase: "prepare" }),
		phases: {
			prepare: async (task, runtime, context) => {
				const isolated = task.input.request.workspaceMode === "worktree";
				const workspace = isolated
					? await prepareWorkspace(
							task.input.repository,
							config.stateDir,
							Number(task.id),
							task.input.baseCommit,
						)
					: task.input.repository;
				const owner = operatorOwner(Number(task.id), task.input, workspace);
				const plans = operatorInfrastructurePlans(
					(
						await manager.resolvePlans(
							owner,
							task.input.request.apps,
							task.input.request.action,
							task.input.request,
						)
					).map((plan) =>
						plan.kubernetes
							? {
									...plan,
									clusterConnection: manager.prepareCluster(
										owner,
										plan.kubernetes.cluster,
									),
								}
							: plan,
					),
					task.input.request.apps,
					task.input.request.lifetime,
				);
				validateLifetime(plans, owner);
				const snapshot = `${environmentApproval(plans, 30)}\n\nDirect environment control: no model or agent is invoked. ${isolated ? `Commands run in the displayed isolated worktree at captured commit ${task.input.baseCommit}; uncommitted repository changes are not copied.` : `Commands run directly in the displayed authorized developer checkout, including its uncommitted files. HEAD must remain ${task.input.baseCommit} until dispatch. Uncommitted contents are mutable, not a frozen content snapshot. Commands can modify this checkout; worktree isolation is not provided.`} Run resources remain held by this native task until explicitly stopped, process exit or host shutdown. ${task.input.request.lifetime ? "Each explicit infrastructure unit is independently controlled; its exact common topology remains held until every original unit settles. No inferred app root, another native owner or global-host binding is authorized." : "Stopping any coupled batch member stops its dependencies and other members."} Saved state never restores live process authority after restart.`;
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(Catalog);
					doc.tasks[String(task.id)] = JSON.stringify(owner);
					const id = `review-${task.id}`;
					if (
						doc.reviews[id] &&
						decode<Review>(doc.reviews[id]).snapshot !== snapshot
					)
						throw new Error(
							"Environment review changed; request a fresh action",
						);
					doc.reviews[id] ??= JSON.stringify({
						id,
						taskId: Number(task.id),
						topicId: owner.topicId,
						path: workspace,
						title: `Environment ${task.input.request.action}: ${task.input.request.apps.join(", ")}`,
						snapshot,
						digest: digest(snapshot),
						state: "pending",
						comments: "",
						revision: 1,
						createdAt: Date.now(),
					} satisfies Review);
					return {
						status: "running",
						checkpoint: { phase: "review", owner, plans, snapshot },
					};
				}, context);
			},
			review: async (task, runtime, context) => {
				const review = await waitForReview(
					`review-${task.id}`,
					runtime,
					context,
				);
				if (
					review.state !== "approved" ||
					review.snapshot !== task.state.checkpoint.snapshot
				)
					return runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message: "Exact current environment plan was not approved",
								},
							},
						}),
						context,
					);
				await runtime.commit(
					() => ({
						status: "running",
						checkpoint: { ...task.state.checkpoint, phase: "execute" },
					}),
					context,
				);
			},
			execute: async (task, runtime, context) => {
				if (
					task.input.request.workspaceMode !== "worktree" &&
					(
						await git(task.input.repository, ["rev-parse", "--verify", "HEAD"])
					).trim() !== task.input.baseCommit
				)
					return runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message:
										"Developer checkout HEAD changed after admission; request a fresh action",
								},
							},
						}),
						context,
					);
				// Persist before dispatch. An ambiguous native phase restart must not execute again.
				if (await runtime.memo("environment-issued", context))
					return runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message:
										"Environment dispatch was interrupted; inspect existing resources and request a fresh action. No automatic replay",
								},
							},
						}),
						context,
					);
				await runtime.memo("environment-issued", true, context);
				const checkpoint = task.state.checkpoint;
				try {
					const result = await manager.execute(
						`env-${task.id}`,
						JSON.stringify(task.input),
						checkpoint.owner,
						checkpoint.plans,
						30000,
						context.abortSignal,
					);
					if (task.input.request.action === "run") {
						await runtime.commit(
							() => ({
								status: "running",
								checkpoint: { ...checkpoint, phase: "held" },
							}),
							context,
						);
					} else {
						if (
							!Array.isArray(result) ||
							!result.length ||
							result.some(
								(run) =>
									run.state !== "exited" || run.exitCode !== 0 || run.error,
							)
						)
							return runtime.commit(
								() => ({
									status: "terminal",
									outcome: {
										status: "failed",
										error: {
											message:
												"Environment action exited unsuccessfully; inspect its exit status and redacted logs",
										},
									},
								}),
								context,
							);
						await runtime.commit(
							() => ({
								status: "terminal",
								outcome: {
									status: "completed",
									result: JSON.stringify(
										result.map((run) => ({
											id: run.id,
											app: run.plan.app,
											state: run.state,
											exitCode: run.exitCode,
										})),
									),
								},
							}),
							context,
						);
					}
				} catch (error) {
					await manager.releaseOwner(Number(task.id));
					throw error;
				}
			},
			held: async (task, runtime, context) => {
				const watch = await runtime.watchDoc(EnvironmentState, context);
				if (!watch) throw new Error("Environment state is missing");
				const ended = (value: typeof watch.value) => {
					const runs = Object.values(value?.runs ?? {})
						.map(decode<EnvironmentRun>)
						.filter((run) => run.owner === Number(task.id));
					if (runs.some((run) => run.state === "interrupted"))
						return "interrupted";
					if (runs.some(holdsResource)) return null;
					const roots = runs.filter((run) =>
						task.input.request.apps.includes(run.plan.app),
					);
					return roots.length && roots.every((run) => run.exitCode === 0)
						? "exited"
						: "failed";
				};
				let outcome = ended(watch.value);
				try {
					if (!outcome)
						outcome = await new Promise<"exited" | "interrupted" | "failed">(
							(resolve, reject) => {
								watch.start(async (value) => {
									const result = ended(value);
									if (result) resolve(result);
								});
								void watch.closed.then(() =>
									reject(new Error("Environment lifetime wait interrupted")),
								);
							},
						);
				} finally {
					await watch.stop();
				}
				if (outcome !== "exited")
					return runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message:
										outcome === "interrupted"
											? "Environment ownership interrupted; inspect quarantined resources before release"
											: "Environment batch exited unsuccessfully; inspect exit status and redacted logs",
								},
							},
						}),
						context,
					);
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: {
							status: "completed",
							result:
								"Environment batch exited and released its live resources",
						},
					}),
					context,
				);
			},
		},
		abort: async (task, runtime, context) => {
			const cleanup = await manager.releaseOwner(Number(task.id));
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(Catalog),
					id = `review-${task.id}`,
					raw = doc.reviews[id];
				if (raw) {
					const review = decode<Review>(raw);
					if (review.state === "pending") {
						review.state = "cancelled";
						review.revision++;
						doc.reviews[id] = JSON.stringify(review);
					}
				}
				return {
					status: "terminal",
					outcome: {
						status: "aborted",
						reason: `Stopped by operator${cleanup ? `\n${cleanup}` : ""}`,
					},
				};
			}, context);
		},
	});
}
