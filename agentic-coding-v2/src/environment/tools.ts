import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requestReview } from "../reviews.ts";
import type { TaskInfo } from "../state.ts";
import { environmentApproval } from "./approval.ts";
import { resolvePlans } from "./catalog.ts";
import { createHttpTools } from "./http-tools.ts";
import { type Lifetime, validateLifetime } from "./lifetime.ts";
import type { Environments } from "./manager.ts";
import { createQueryTools } from "./query-tools.ts";
import type { Action, Selection } from "./selection.ts";
import { environmentResult } from "./tool-result.ts";

export const environmentInspectionTools = new Set([
	"env_discover",
	"env_list",
	"env_status",
	"env_logs",
	"otel_query",
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
		retainQueue = false,
		lifetime?: Lifetime,
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
				...(retainQueue ? { retainQueue: true } : {}),
				...(lifetime ? { lifetime } : {}),
			});
		const previous = await manager.receipt(batch, owner.id, request);
		if (previous) return environmentResult(previous);
		const recorded = await manager.acquisitions.recordedWait(
			batch,
			owner.id,
			batch,
			request,
			timeoutSec * 1000,
		);
		if (recorded) return environmentResult(recorded);
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
		if (lifetime) for (const plan of plans) plan.lifetime = lifetime;
		validateLifetime(plans, owner);
		const snapshot = environmentApproval(plans, timeoutSec, retainQueue);
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
				retainQueue,
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
			...createHttpTools(manager, ownerOf),
			...createQueryTools(manager.database, ownerOf),
			defineTool({
				name: "env_discover",
				description:
					"Inspect bounded root-only repository manifest evidence and untrusted package-script invocation hints, without executing commands or CLI probes, reading private configuration, editing/importing files or granting approval authority. Choose an exact configured repository path. The home orchestrator reads its developer checkout; native skill tasks can inspect only their own task workspace, never another repository. Only package.json contents (maximum 64 KiB) are parsed; script bodies are withheld. Other known root build/container/lock files are metadata only; symlinks are not followed. No defaults, nested layouts, service topology, readiness or runtime compatibility inferred. This does not author, validate, promote or reload environments.json, and does not renew app leases.",
				parameters: Type.Object(
					{ repository: Type.String({ minLength: 1, maxLength: 4096 }) },
					{ additionalProperties: false },
				),
				replay: "safe",
				execute: async (args, api) =>
					environmentResult(
						manager.discover(
							args.repository,
							(await ownerOf(api.conversationId)) ?? undefined,
						),
					),
			}),
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
					"List configured environment projects, profiles, declared/default target choices, current task-owned slots, idle protection/countdowns and acquisition queues. Owner-wide reads renew all this task's eligible roots (legacy owner batch or explicitly independent roots), never another task. No live legacy environments are imported.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, api) => {
					const owner = await ownerOf(api.conversationId);
					if (owner) manager.idle.touch(owner.id);
					return environmentResult(await manager.snapshot());
				},
			}),
			defineTool({
				name: "env_status",
				description:
					"Inspect environment run receipts, process exit status, readiness, task ownership, idle protection/countdowns and recorded expiry reasons. App-filtered inspection renews only the selected explicitly independent root; unfiltered inspection renews all this task's roots. Legacy activity remains owner-wide. Interrupted effects require developer inspection; never kill a saved PID.",
				parameters: Type.Object({ app: Type.Optional(Type.String()) }),
				replay: "safe",
				execute: async (args, api) => {
					const owner = await ownerOf(api.conversationId);
					if (owner) manager.idle.touch(owner.id, args.app);
					return environmentResult(await manager.snapshot(args.app));
				},
			}),
			defineTool({
				name: "env_logs",
				description:
					"Read this task's retained, already-secret-redacted app logs: literal grep (not regex), then newest matching tail (default 200, maximum 1000 per run). At most 20 recent/live runs, with one shared 12 KiB encoded-output budget; whole lines only, omissions/counts explicit. No runtime CLI calls or historical completeness guarantee. Compose output is aggregate service buffers, not chronological; Kubernetes returns client diagnostics, not Pod logs. Optional service selects an exact declared Compose service's captured buffer, never parsed header text or the stack-network buffer; unavailable/legacy/other-runtime captures are explicit and never fall back to aggregate output. Choose exactly one app or infra ID; infra selects only immutable infrastructure-kind run snapshots, not app history relabelled by current configuration. Infrastructure is exclusively task-owned, not shared/external. Optional since is a strict ISO 8601 instant: filter by native shell host receipt time of completed lines, not application/event timestamps or text prefixes, before grep/tail. Missing timing (old receipts, Compose/services, containers and Kubernetes) returns no dated lines with explicit metadata, never silently unfiltered output. Timing is bounded to the newest 2048 complete records/64k characters; a crash can lose later observations. A referenced-roots-v1 prerequisite has no activity clock of its own: reading it renews the one live root that declares it, and is refused while more than one live root declares it rather than renewing every dependent. The home orchestrator may inspect all host runs.",
				parameters: Type.Object({
					app: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
					infra: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
					grep: Type.Optional(Type.String({ maxLength: 512 })),
					since: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
					service: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
					tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
				}),
				replay: "safe",
				execute: async (args, api) => {
					if ((args.app === undefined) === (args.infra === undefined))
						throw new Error("Choose exactly one app or infra log source");
					const id = args.app ?? args.infra;
					if (!id) throw new Error("Choose a nonempty log source");
					return environmentResult(
						await manager.selectedLogs(
							id,
							(await ownerOf(api.conversationId))?.id,
							{
								...args,
								...(args.infra ? { kind: "infrastructure" as const } : {}),
							},
						),
					);
				},
			}),
			defineTool({
				name: "otel_query",
				description:
					"Read only this task's live ready shell app's opt-in native OTLP/HTTP JSON observations. An exact approved telemetry target creates a per-run authenticated ephemeral loopback receiver; no external backend queries, shared/global capture, saved-token adoption or execution effects. Traces mode lists retained trace summaries, or returns flat spans with parent IDs for traceId; logs mode reads retained structured log records. Since selects host receipt time, not exporter event time. Windows, protobuf/gRPC, metrics, events/links, provider integration and live-runtime parity are not claimed. Resource attributes cannot change native app/task/run attribution. Availability is checked before name/status/since filtering: retained spans remain retained even with zero matches. Recently evicted trace IDs are distinguished from unknown using a bounded 200-ID window; unknown is not proof a trace never existed. Linked log availability is independent of span retention. Bounded counts, encoded-data windows and whole-record output omissions are explicit; no historical completeness guarantee. Native skill reads are owner scoped. A referenced-roots-v1 run additionally discloses and revalidates its exact root and prerequisite generations, and a prerequisite read renews the one live root that declares it, refusing ambiguity. The home orchestrator may inspect a live held host run.",
				parameters: Type.Object({
					app: Type.String({ minLength: 1, maxLength: 64 }),
					mode: Type.Optional(
						Type.Union([Type.Literal("traces"), Type.Literal("logs")]),
					),
					traceId: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{32}$" })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
					since: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
					status: Type.Optional(
						Type.Union([
							Type.Literal("all"),
							Type.Literal("error"),
							Type.Literal("success"),
						]),
					),
					name: Type.Optional(Type.String({ maxLength: 512 })),
					severity: Type.Optional(Type.String({ maxLength: 64 })),
					text: Type.Optional(Type.String({ maxLength: 512 })),
				}),
				replay: "safe",
				execute: async (args, api) => {
					const { app, ...options } = args;
					return environmentResult(
						await manager.queryTelemetry(
							app,
							(await ownerOf(api.conversationId))?.id,
							options,
						),
					);
				},
			}),
			defineTool({
				name: "env_start",
				description:
					"Request human approval for exact configured run commands and acquire all explicitly named apps and task-owned infrastructure resources atomically in FIFO order. Infrastructure is run-only, exclusive, not shared/external. Declared same-repository requires are expanded through their configured default targets, bounded to 16 total projects, and started dependency-first. Dependency batches have coupled lifetimes: stopping or losing any member cleans up all members, not partial last-reference release. No implicit Kubernetes starts. Explicit lifetime:independent-roots-v1 instead requests independent scoped activity/idle/stop for agent-owned standalone shell app roots only, after atomic startup. Explicit lifetime:referenced-roots-v1 instead keeps one atomic acquisition but releases app roots independently: declared shell infrastructure prerequisites are retained by the remaining roots and cleaned only with the last reference, dependent-first. Both modes refuse other runtimes and require agent ownership. No second held run acquisition or expired sibling reacquisition while another root remains held. Legacy defaults and operator actions are unchanged. Only this task's repository/workspace is allowed. An identical complete live plan held by this task returns an explicit already-held receipt without executing again or reapplying secrets/workspace content. Changed/partial/closing/interrupted/foreign plans are not reusable. Release an existing batch before acquiring different apps. Shell readiness uses optional readyText; containers require running state or configured engine health. Opt-in native telemetry additionally discloses a per-run authenticated ephemeral loopback JSON receiver and exporter variables; its buffers and receiver close with the owned shell process and grant no saved authority. Compose supports a limited file subset: Docker shared mode uses an owned bridge with service-name aliases; explicitly isolated mode has no shared network/DNS. Shared Podman networking is unavailable. Kubernetes requires an explicitly named target or runtime and an approved local context; only bare pods in an existing non-system namespace are supported, with optional bounded HTTP/TCP kubelet readiness probes and API Ready observations (not end-to-end application verification), live UID receipts and UID-preconditioned cleanup. Acquisition timeout normally releases queue position. Explicit retainQueue:true adds a disclosed retained wait receipt for env_wait continuation of only this approved plan, with no apps reserved/started between calls. Stops, task cleanup and host shutdown/restart invalidate the live entry; saved queue records never restore authority.",
				parameters: Type.Object({
					apps: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
					retainQueue: Type.Optional(Type.Boolean()),
					lifetime: Type.Optional(
						Type.Union([
							Type.Literal("independent-roots-v1"),
							Type.Literal("referenced-roots-v1"),
						]),
					),
					...selectionFields,
					timeoutSec: Type.Optional(
						Type.Integer({ minimum: 1, maximum: 7200 }),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) =>
					execute(
						"run",
						args.apps,
						args,
						args.timeoutSec ?? 30,
						api,
						context,
						args.retainQueue === true,
						args.lifetime,
					),
			}),
			defineTool({
				name: "env_wait",
				description:
					"Continue only this native task's live retained acquisition from an explicitly retainQueue-approved env_start. No app/target/runtime changes or new execution authority: use the original acquisition ID. FIFO place survives bounded calls, not host restart. A completed poll replay returns diagnostics, never re-enqueues or adopts saved resources. Cancelling/stopping/completing the task releases its retained position.",
				parameters: Type.Object({
					acquisition: Type.String({ minLength: 1, maxLength: 128 }),
					timeoutSec: Type.Optional(
						Type.Integer({ minimum: 1, maximum: 7200 }),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					if (!owner)
						throw new Error(
							"Queue continuation requires the original native skill task",
						);
					return environmentResult(
						await manager.acquisitions.continueWait(
							`env-wait-${api.taskId}`,
							owner,
							args.acquisition,
							(args.timeoutSec ?? 30) * 1000,
							context.abortSignal,
						),
					);
				},
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
					"Stop only apps started by this task, with confirmed live process-group or receipt-fenced runtime cleanup before release. Kubernetes deletion requires live creation UIDs and API UID preconditions. Never stops another task's apps or adopts persisted PIDs/IDs. Also cancels matching pending acquisitions. For a coupled dependency batch, selecting any member stops every member, dependents before dependencies, as disclosed by its immutable startup approval.",
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
					manager.idle.touch(owner.id);
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
