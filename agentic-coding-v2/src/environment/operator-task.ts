import { defineTask } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { digest } from "../config.ts";
import { git, prepareWorkspace } from "../git.ts";
import { waitForReview } from "../reviews.ts";
import { Catalog, decode, type Review, type TaskInfo } from "../state.ts";
import { environmentApproval } from "./approval.ts";
import {
	type OperatorLifetime,
	operatorHostAnchor,
	operatorInfrastructurePlans,
	renewableOperator,
	validateLifetime,
} from "./lifetime.ts";
import type { Environments } from "./manager.ts";
import type { Plan } from "./model.ts";
import type { Action, Selection } from "./selection.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
	type OperatorUnitStart,
} from "./state.ts";

export type OperatorAction = Selection & {
	apps: string[];
	action: Action;
	requestId: string;
	baseRef?: string;
	workspaceMode?: "checkout" | "worktree";
	lifetime?: OperatorLifetime;
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
type UnitCheckpoint<P extends "unit-review" | "unit-execute"> =
	ActiveCheckpoint<P> & {
		unitId: string;
		unitPlans: Plan[];
		unitSnapshot: string;
	};
type Checkpoint =
	| { phase: "prepare" }
	| ActiveCheckpoint<"review">
	| ActiveCheckpoint<"execute">
	| ActiveCheckpoint<"held">
	| (ActiveCheckpoint<"unit-prepare"> & { unitId: string })
	| UnitCheckpoint<"unit-review">
	| UnitCheckpoint<"unit-execute">;

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
				const snapshot = `${environmentApproval(plans, 30)}\n\nDirect environment control: no model or agent is invoked. ${isolated ? `Commands run in the displayed isolated worktree at captured commit ${task.input.baseCommit}; uncommitted repository changes are not copied.` : `Commands run directly in the displayed authorized developer checkout, including its uncommitted files. HEAD must remain ${task.input.baseCommit} until dispatch. Uncommitted contents are mutable, not a frozen content snapshot. Commands can modify this checkout; worktree isolation is not provided.`} Run resources remain held by this native task until explicitly stopped, process exit or host shutdown. ${plans.some(operatorHostAnchor) ? "V3 retains the original empty topology under this protected native owner until explicit owner cancellation/revocation or host shutdown; no keeper, saved-ID restoration, new owner or cross-owner borrowing is authorized. Confirmed released selected services require fresh native reviews to re-add." : task.input.request.lifetime ? "Each explicit infrastructure unit is independently controlled; its exact common topology remains held until every original unit settles. No inferred app root, another native owner or global-host binding is authorized." : "Stopping any coupled batch member stops its dependencies and other members."} Saved state never restores live process authority after restart.`;
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
			"unit-prepare": async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint,
					owner = Number(task.id),
					reviewId = `review-${task.id}-unit-${checkpoint.unitId.slice(0, 32)}`;
				try {
					const scope = await manager.unitStarts.context(
						checkpoint.unitId,
						owner,
					);
					const unitPlans = operatorInfrastructurePlans(
						await manager.resolvePlans(
							checkpoint.owner,
							[scope.unit.plan.app],
							"run",
							{ target: scope.unit.plan.id },
						),
						[scope.unit.plan.app],
						scope.lifetime,
					).map((plan) =>
						plan.operatorRoot
							? { ...plan, operatorTopology: scope.topology.id }
							: plan,
					);
					await manager.unitStarts.verify(checkpoint.unitId, owner, unitPlans);
					const unitSnapshot = `${environmentApproval(unitPlans, 30)}\n\nRe-add one confirmed released unit through its original protected native owner. Fresh approval of exactly this generation is required; no restart of a live unit, second topology, owner substitution or automatic replay. ${JSON.stringify(scope.request)}`;
					await runtime.commit(async (tx) => {
						const env = await tx.doc(EnvironmentState),
							doc = await tx.doc(Catalog),
							raw = env.unitStarts?.[checkpoint.unitId];
						if (!raw || decode<OperatorUnitStart>(raw).state !== "pending")
							throw new Error("Unit request changed before review");
						if (env.unitStarts)
							env.unitStarts[checkpoint.unitId] = JSON.stringify({
								...scope.request,
								state: "review",
							});
						if (
							doc.reviews[reviewId] &&
							decode<Review>(doc.reviews[reviewId]).snapshot !== unitSnapshot
						)
							throw new Error("Unit review changed; no substitution");
						doc.reviews[reviewId] ??= JSON.stringify({
							id: reviewId,
							taskId: owner,
							topicId: checkpoint.owner.topicId,
							path: checkpoint.owner.workspace,
							title: `Environment re-add: ${scope.unit.plan.app}`,
							snapshot: unitSnapshot,
							digest: digest(unitSnapshot),
							state: "pending",
							comments: "",
							revision: 1,
							createdAt: Date.now(),
						} satisfies Review);
						return {
							status: "running",
							checkpoint: {
								...checkpoint,
								phase: "unit-review",
								unitPlans,
								unitSnapshot,
							},
						};
					}, context);
				} catch {
					await manager.unitStarts.settle(
						checkpoint.unitId,
						owner,
						"interrupted",
						"Original unit/topology context unavailable; no re-add dispatched",
					);
					await runtime.commit(
						() => ({
							status: "running",
							checkpoint: { ...checkpoint, phase: "held" },
						}),
						context,
					);
				}
			},
			"unit-review": async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint,
					review = await waitForReview(
						`review-${task.id}-unit-${checkpoint.unitId.slice(0, 32)}`,
						runtime,
						context,
					);
				if (
					review.state !== "approved" ||
					review.snapshot !== checkpoint.unitSnapshot
				) {
					await manager.unitStarts.settle(
						checkpoint.unitId,
						Number(task.id),
						"rejected",
					);
					return runtime.commit(
						() => ({
							status: "running",
							checkpoint: { ...checkpoint, phase: "held" },
						}),
						context,
					);
				}
				await runtime.commit(
					() => ({
						status: "running",
						checkpoint: { ...checkpoint, phase: "unit-execute" },
					}),
					context,
				);
			},
			"unit-execute": async (task, runtime, context) => {
				const checkpoint = task.state.checkpoint,
					owner = Number(task.id),
					memo = `unit-issued:${checkpoint.unitId}`;
				try {
					if (await runtime.memo(memo, context))
						throw new Error("Unit dispatch was interrupted; no replay");
					const request = await manager.unitStarts.verify(
						checkpoint.unitId,
						owner,
						checkpoint.unitPlans,
					);
					if (
						(
							await git(checkpoint.owner.workspace, [
								"rev-parse",
								"--verify",
								"HEAD",
							])
						).trim() !== task.input.baseCommit
					)
						throw new Error("Original operator workspace HEAD changed");
					validateLifetime(checkpoint.unitPlans, checkpoint.owner);
					await runtime.memo(memo, true, context);
					await manager.unitStarts.settle(checkpoint.unitId, owner, "issued");
					await manager.execute(
						request.batch,
						JSON.stringify({ request, approved: checkpoint.unitSnapshot }),
						checkpoint.owner,
						checkpoint.unitPlans,
						30000,
						context.abortSignal,
					);
					await manager.unitStarts.settle(
						checkpoint.unitId,
						owner,
						"completed",
					);
				} catch {
					await manager.unitStarts.settle(
						checkpoint.unitId,
						owner,
						"interrupted",
						"Unit dispatch failed or was interrupted; inspect native runs; no replay",
					);
				}
				await runtime.commit(
					() => ({
						status: "running",
						checkpoint: { ...checkpoint, phase: "held" },
					}),
					context,
				);
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
					if (runs.some(holdsResource)) {
						if (task.state.checkpoint.plans.some(renewableOperator)) {
							const pending = Object.values(value?.unitStarts ?? {})
								.map(decode<OperatorUnitStart>)
								.find(
									(row) =>
										row.owner === Number(task.id) && row.state === "pending",
								);
							if (pending) return { unitId: pending.id };
						}
						return null;
					}
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
						outcome = await new Promise<NonNullable<ReturnType<typeof ended>>>(
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
				if (typeof outcome === "object" && outcome)
					return runtime.commit(
						() => ({
							status: "running",
							checkpoint: {
								...task.state.checkpoint,
								phase: "unit-prepare",
								unitId: outcome.unitId,
							},
						}),
						context,
					);
				await manager.unitStarts.closeOwner(Number(task.id));
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
				const env = await tx.doc(EnvironmentState);
				for (const [id, raw] of Object.entries(env.unitStarts ?? {})) {
					const row = decode<OperatorUnitStart>(raw);
					if (
						row.owner === Number(task.id) &&
						["pending", "review", "issued"].includes(row.state) &&
						env.unitStarts
					)
						env.unitStarts[id] = JSON.stringify({
							...row,
							state: "interrupted",
							error: "Original operator cancelled; no replay",
						});
				}
				const doc = await tx.doc(Catalog);
				for (const [id, raw] of Object.entries(doc.reviews)) {
					const review = decode<Review>(raw);
					if (review.taskId === Number(task.id) && review.state === "pending")
						doc.reviews[id] = JSON.stringify({
							...review,
							state: "cancelled",
							revision: review.revision + 1,
						});
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
