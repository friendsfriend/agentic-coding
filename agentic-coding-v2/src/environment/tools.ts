import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { toolResult } from "../agent-tools.ts";
import { requestReview } from "../reviews.ts";
import type { TaskInfo } from "../state.ts";
import { type Action, resolvePlans } from "./catalog.ts";
import type { Environments } from "./manager.ts";
import type { Selection } from "./selection.ts";

function environmentResult(value: unknown) {
	const encoded = JSON.stringify(value);
	return toolResult(
		encoded.length > 40000
			? `${encoded.slice(0, 39500)}\n[truncated; narrow env_status/env_logs to an app]`
			: encoded,
	);
}
export const environmentInspectionTools = new Set([
	"env_list",
	"env_status",
	"env_logs",
]);
export function createEnvironmentTools(
	manager: Environments,
	ownerOf: (id: ConversationId) => Promise<TaskInfo | null>,
) {
	async function execute(
		action: Action,
		apps: string[],
		selection: Selection,
		timeoutSec: number,
		api: ToolExecutionApi,
		context: Context,
	) {
		const owner = await ownerOf(api.conversationId);
		if (!owner)
			throw new Error("Environment execution requires a native skill task");
		const batch = `env-${api.taskId}`,
			request = JSON.stringify({
				action,
				apps,
				target: selection.target ?? null,
				...(selection.profile === undefined
					? {}
					: { profile: selection.profile }),
				...(selection.runtime === undefined
					? {}
					: { runtime: selection.runtime }),
				...(selection.replicas === undefined
					? {}
					: { replicas: selection.replicas }),
				timeoutSec,
			});
		const previous = await manager.receipt(batch, owner.id, request);
		if (previous) return environmentResult(previous);
		const plans = resolvePlans(
			manager.projects,
			owner,
			apps,
			action,
			selection,
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
		);
		const snapshot = JSON.stringify(
			{
				plans,
				waitTimeoutMs: timeoutSec * 1000,
				...(plans.some((plan) => plan.kubernetes)
					? {
							kubernetesScope:
								"Bare pods only in the displayed existing non-system namespace and explicit local cluster. No cluster/namespace creation, Helm, controllers or host mounts; automatic service-account token mounting and privilege escalation are disabled in the requested pod spec. No existing pod adoption, even with matching labels. Only live creation UIDs and host/run labels authorize cleanup; DELETE uses live UID and observed resource-version preconditions, a five-second grace period and orphan propagation, never cascading namespace deletion. Declared environment values and resolved secret references are sent to the Kubernetes API as Pod env values, where authorized cluster readers can see them and the API can persist them. The local client receives them only on private stdin, not argv or manifest files; this is not Kubernetes Secret-object integration. All replicas are created before readiness waits. Only HTTP/TCP pod-local kubelet readiness probes are supported, with bounded timing and no exec/host/header overrides. HTTPS probes use kubelet semantics without certificate verification; TCP probes only test socket acceptance. Pod Ready without a probe is not application health. API-observed readiness loss after startup is reported unhealthy, not an automatic stop. Pod logs, services and port forwards are not yet supported. API/identity loss or uncertain writes quarantine the app slot. The configured image and commands can execute code and make network requests; this is not an OS sandbox.",
						}
					: {}),
				...(plans.some((plan) => plan.compose)
					? {
							composeScope:
								"Limited Compose-file adapter, not compose up/down. Docker shared mode creates an exclusive host/app-specific bridge network with service-name aliases, fenced by its live immutable creation ID. Explicit isolated mode has no shared network or service-name DNS. Only empty, identity-verified owned networks may be removed; no force disconnect, external network adoption or cross-provider DNS. Dependencies support only service_started and service_healthy, using actual engine running/image health observations. No healthcheck overrides, interpolation, named/external resources, build/test or extends. Each service receives the target environment and secret references. Only literal environments, argv commands, long-form ports and contained bind mounts are supported.",
						}
					: {}),
				authority:
					"Execute these exact configured environment actions in the task workspace. Container clients use only the explicit local API socket, never the default or a remote daemon context. Named containers are never adopted; only resources created by this live operation with matching host/run labels may be stopped or removed. Container build artifacts can persist in the local engine. Not an OS sandbox. Only conventional PATH/HOME/LANG/TMPDIR/TERM plus the displayed literal variables, referenced secrets, WORKSPACE and CONFIG_DIR are passed. Run targets last until stopped, task completion/cancellation or host shutdown. No automatic replay after ambiguous interruption.",
			},
			null,
			2,
		);
		const review = await requestReview(
			owner,
			{
				title: `Environment ${action}: ${apps.join(", ")}`,
				path: owner.workspace,
				snapshot,
			},
			api,
			context,
		);
		if (review.state !== "approved" || review.snapshot !== snapshot)
			throw new Error("Exact current environment plan was not approved");
		return environmentResult(
			await manager.execute(
				batch,
				request,
				owner,
				plans,
				timeoutSec * 1000,
				context.abortSignal,
			),
		);
	}
	const target = Type.Optional(Type.String({ maxLength: 200 }));
	const selectionFields = {
		target,
		replicas: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
		profile: Type.Optional(Type.String({ maxLength: 64 })),
		runtime: Type.Optional(
			Type.Union([
				Type.Literal("shell"),
				Type.Literal("docker"),
				Type.Literal("podman"),
				Type.Literal("compose"),
				Type.Literal("kubernetes"),
			]),
		),
	};
	return defineExtension({
		name: "v2.environments",
		tools: [
			defineTool({
				name: "env_cluster_status",
				description:
					"Request human approval to inspect the API identity of one explicitly configured local Kubernetes context. No default context, cluster creation, app start, secret inspection or cleanup/adoption authority. Credential plugins and inline credentials are unsupported.",
				parameters: Type.Object({ cluster: Type.String({ maxLength: 64 }) }),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					if (!owner)
						throw new Error("Cluster inspection requires a native skill task");
					const inspection = manager.prepareCluster(owner, args.cluster),
						snapshot = JSON.stringify(
							{
								inspection,
								authority:
									"Read-only Kubernetes API identity inspection using kubectl get namespace kube-system (including read-only API discovery). Only the displayed HTTPS numeric loopback server and explicit context are used. Credential file references may be read by kubectl; inline credentials, exec/auth plugins, insecure TLS and proxy settings are rejected. No cluster/resource creation, modification, deletion or adoption. This is API reachability, not workload readiness. CLI observations stay private. Not an OS sandbox.",
							},
							null,
							2,
						);
					const review = await requestReview(
						owner,
						{
							title: `Cluster status: ${args.cluster}`,
							path: owner.workspace,
							snapshot,
						},
						api,
						context,
					);
					if (review.state !== "approved" || review.snapshot !== snapshot)
						throw new Error(
							"Exact current cluster inspection was not approved",
						);
					return environmentResult(
						await manager.inspectCluster(
							owner,
							inspection,
							context.abortSignal,
						),
					);
				},
			}),
			defineTool({
				name: "env_list",
				description:
					"List configured environment projects, profiles, declared/default target choices, current task-owned slots and acquisition queues. No live legacy environments are imported.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => environmentResult(await manager.snapshot()),
			}),
			defineTool({
				name: "env_status",
				description:
					"Inspect environment run receipts, process exit status, readiness and task ownership. Interrupted effects require developer inspection; never kill a saved PID.",
				parameters: Type.Object({ app: Type.Optional(Type.String()) }),
				replay: "safe",
				execute: async (args) =>
					environmentResult(await manager.snapshot(args.app)),
			}),
			defineTool({
				name: "env_logs",
				description:
					"Read bounded, known-secret-redacted complete log lines from this task's environment executions. The home orchestrator may inspect all host runs. In-progress unterminated lines are withheld.",
				parameters: Type.Object({ app: Type.String() }),
				replay: "safe",
				execute: async (args, api) =>
					environmentResult(
						await manager.logs(
							args.app,
							(await ownerOf(api.conversationId))?.id,
						),
					),
			}),
			defineTool({
				name: "env_start",
				description:
					"Request human approval for exact configured run commands and acquire all apps atomically in FIFO order. Only this task's repository/workspace is allowed. Release an existing batch before acquiring more apps. Shell readiness uses optional readyText; containers require running state or configured engine health. Compose supports a limited file subset: Docker shared mode uses an owned bridge with service-name aliases; explicitly isolated mode has no shared network/DNS. Shared Podman networking is unavailable. Kubernetes requires an explicitly named target or runtime and an approved local context; only bare pods in an existing non-system namespace are supported, with optional bounded HTTP/TCP kubelet readiness probes and API Ready observations (not end-to-end application verification), live UID receipts and UID-preconditioned cleanup. Acquisition timeout releases queue position; no app starts on timeout.",
				parameters: Type.Object({
					apps: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
					...selectionFields,
					timeoutSec: Type.Optional(
						Type.Integer({ minimum: 1, maximum: 7200 }),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) =>
					execute("run", args.apps, args, args.timeoutSec ?? 30, api, context),
			}),
			...(["build", "test"] as const).map((action) =>
				defineTool({
					name: `env_${action}`,
					description: `Request human approval and execute one configured ${action} target in this task's workspace, returning exit status and redacted output. Requires no app slot; one build/test action at a time per workspace. Action timeouts are configured per target.`,
					parameters: Type.Object({ app: Type.String(), ...selectionFields }),
					replay: "safe",
					executionMode: "sequential",
					execute: async (args, api, context) =>
						execute(action, [args.app], args, 30, api, context),
				}),
			),
			defineTool({
				name: "env_stop",
				description:
					"Stop only apps started by this task, with confirmed live process-group or receipt-fenced runtime cleanup before release. Kubernetes deletion requires live creation UIDs and API UID preconditions. Never stops another task's apps or adopts persisted PIDs/IDs. Also cancels matching pending acquisitions.",
				parameters: Type.Object({
					apps: Type.Optional(
						Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api) => {
					const owner = await ownerOf(api.conversationId);
					if (!owner)
						throw new Error(
							"Stopping environments requires their owning skill task",
						);
					return environmentResult({
						stopped: await manager.stopOnce(
							`env-stop-${api.taskId}`,
							owner.id,
							args.apps,
						),
					});
				},
			}),
		],
	});
}
