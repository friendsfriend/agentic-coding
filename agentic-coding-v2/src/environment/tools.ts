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
import { httpOptions } from "./http-options.ts";
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
				...(plans.some((plan) => plan.projectKind === "infrastructure")
					? {
							infrastructureScope:
								"Exclusive task-owned run resources only, all listed in this approved atomic plan. Declared same-repository owned dependencies may expand the request. Same workspace and live-receipt cleanup fences as apps. No shared/external infrastructure, imported leases, saved-ID adoption, implicit image builds or database query authority.",
						}
					: {}),
				...(plans.some((plan) => plan.dependencyBatch)
					? {
							dependencyScope:
								"Declared owned infrastructure is acquired atomically with every requested app, at most 16 projects (Compose services and Pod replicas retain their own bounds), and started dependency-first through each configured readiness observation. This is one coupled-lifetime batch: stopping ANY member, ANY member exiting, startup failure, task cleanup or host shutdown stops ALL members, dependents before dependencies. No partial release, cross-task sharing, automatic restart or saved-ID adoption. Root target/profile/runtime options do not override automatic dependency defaults. Kubernetes dependencies must be explicitly requested with an eligible target/runtime, never implicitly started.",
						}
					: {}),
				...(action === "run"
					? {
							reuseScope:
								"An identical complete live run plan already held by this same task may return an explicit already-held receipt instead of running again. No additional lease or command, secret re-resolution, changed workspace content application or readiness restart is implied. A changed, partial, closing, interrupted or foreign-owned plan cannot be reused. Saved reuse receipts are references only and never restore process/network/cleanup authority after restart.",
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
				name: "env_http_request",
				description:
					"Request exact human approval for an HTTP operation to this task's live ready shell endpoint. Non-read methods require allowWrite:true. Optional followRedirects permits at most three same-origin redirects within one ten-second deadline; POST 301/302 and non-HEAD 303 become GET without a body, while 307/308 preserve method/body and may replay writes. Optional authenticate uses only configured frozen Basic/Bearer secret references over verified HTTPS, never caller Authorization/cookies. No proxy, foreign origin or other-runtime binding. Responses are bounded and redacted; writes cannot be rolled back by cancellation. A durable native issuance marker prevents automatic resend after an uncertain response or crash; completed replay returns the original diagnostic receipt, never fresh network authority.",
				parameters: Type.Object({
					app: Type.String({ maxLength: 64 }),
					endpoint: Type.String({ maxLength: 64 }),
					path: Type.Optional(Type.String({ maxLength: 2048 })),
					method: Type.Optional(
						Type.Union([
							Type.Literal("GET"),
							Type.Literal("HEAD"),
							Type.Literal("POST"),
							Type.Literal("PUT"),
							Type.Literal("PATCH"),
							Type.Literal("DELETE"),
							Type.Literal("OPTIONS"),
						]),
					),
					headers: Type.Optional(
						Type.Record(Type.String(), Type.String({ maxLength: 1024 })),
					),
					body: Type.Optional(Type.String({ maxLength: 16384 })),
					allowWrite: Type.Optional(Type.Boolean()),
					followRedirects: Type.Optional(Type.Boolean()),
					authenticate: Type.Optional(Type.Boolean()),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					if (!owner)
						throw new Error("Endpoint diagnostics require a native skill task");
					const options = httpOptions({
						method: args.method,
						headers: args.headers,
						body: args.body,
						allowWrite: args.allowWrite,
						followRedirects: args.followRedirects,
						authenticate: args.authenticate,
					});
					const issuance = {
						id: `http-${api.taskId}`,
						input: {
							app: args.app,
							endpoint: args.endpoint,
							path: args.path ?? "/",
							http: options,
						},
					};
					const cached = await manager.httpReceipt(
						owner,
						issuance.id,
						issuance.input,
						context.abortSignal,
					);
					if (cached) return environmentResult(cached);
					const request = await manager.prepareEndpoint(
						owner,
						args.app,
						args.endpoint,
						args.path ?? "/",
						context.abortSignal,
						options,
					);
					const snapshot = JSON.stringify(
						{
							request,
							authority:
								"One direct HTTP operation or explicitly requested bounded same-origin redirect chain to this exact held ready shell endpoint. A durable native issuance marker is written before dispatch; replay returns only a completed original response or refuses uncertain issuance, never resends it. This is not a server-side transaction or exactly-once effect guarantee. The displayed method, headers and body are authorized; non-read methods require allowWrite:true. Writes, GET and redirect replay may cause irreversible server-side effects; cancellation/timeout is not rollback. At most three redirects and ten seconds total: POST 301/302 and non-HEAD 303 become GET without body/content-type; 307/308 preserve method/body. Every hop rechecks owner/live handle and approved public CA source; no different origin, insecure TLS, cookies, proxies, caller credentials, transport headers or other-runtime binding. Optional Basic/Bearer authentication uses only the displayed configured secret-variable references frozen in the live app, over verified HTTPS; referenced credentials are not expanded into this review; known literal secrets and the derived Basic header/base64 value are redacted from results, not arbitrary transformations or encodings. Redirect bodies are omitted; final source is capped at 64 KiB with text-only bounded output and incomplete-line withholding. No socket-to-process ownership proof.",
						},
						null,
						2,
					);
					const review = await requestReview(
						owner,
						{
							title: `Endpoint ${options.method}: ${args.app}/${args.endpoint}`,
							path: owner.workspace,
							snapshot,
						},
						api,
						context,
					);
					if (review.state !== "approved" || review.snapshot !== snapshot)
						throw new Error(
							"Exact current endpoint HTTP operation was not approved",
						);
					return environmentResult(
						await manager.getEndpoint(
							owner,
							request,
							context.abortSignal,
							issuance,
						),
					);
				},
			}),
			defineTool({
				name: "env_http_get",
				description:
					"Request exact human approval for one GET to a named numeric-loopback HTTP/HTTPS endpoint of this task's live ready shell app. HTTPS requires TLS 1.2+ and valid certificate/IP verification, using system trust or one configured public CA file digest-pinned to this approval. No insecure TLS, client credentials, redirects, proxies, cookies, custom headers or writes. GET may have server-side effects. Ten-second deadline, 64 KiB source cap, text-only output and frozen app-secret redaction; discard responses if app ownership ends. No socket-to-process identity proof or other runtimes.",
				parameters: Type.Object({
					app: Type.String({ maxLength: 64 }),
					endpoint: Type.String({ maxLength: 64 }),
					path: Type.Optional(Type.String({ maxLength: 2048 })),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					if (!owner)
						throw new Error("Endpoint diagnostics require a native skill task");
					const issuance = {
						id: `http-${api.taskId}`,
						input: {
							app: args.app,
							endpoint: args.endpoint,
							path: args.path ?? "/",
							http: httpOptions(),
						},
					};
					const cached = await manager.httpReceipt(
						owner,
						issuance.id,
						issuance.input,
						context.abortSignal,
					);
					if (cached) return environmentResult(cached);
					const request = await manager.prepareEndpoint(
							owner,
							args.app,
							args.endpoint,
							args.path ?? "/",
							context.abortSignal,
						),
						snapshot = JSON.stringify(
							{
								request,
								authority:
									"One direct GET to the displayed configured local origin while this exact ready shell app is held. HTTPS verifies the certificate and numeric IP with TLS 1.2+, using system trust unless the displayed public CA reference/digest replaces it. That single public CA file must remain inside the configuration directory and match the approved source digest before sending. No insecure TLS, hostname override, client certificate/key or authentication authority. HTTP is unencrypted; neither scheme proves socket-to-process ownership. GET may cause server-side effects; no redirects, proxy, cookies, credentials or custom headers. Source response bounded to 64 KiB/10 seconds, known app secrets redacted; non-text/encoded bodies omitted. No other methods or origins are approved. A durable native issuance marker prevents automatic resend on uncertain replay; completed replay returns only the original diagnostic response, not fresh authority.",
							},
							null,
							2,
						);
					const review = await requestReview(
						owner,
						{
							title: `Endpoint GET: ${args.app}/${args.endpoint}`,
							path: owner.workspace,
							snapshot,
						},
						api,
						context,
					);
					if (review.state !== "approved" || review.snapshot !== snapshot)
						throw new Error("Exact current endpoint GET was not approved");
					return environmentResult(
						await manager.getEndpoint(
							owner,
							request,
							context.abortSignal,
							issuance,
						),
					);
				},
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
					"Read this task's retained, already-secret-redacted app logs: literal grep (not regex), then newest matching tail (default 200, maximum 1000 per run). At most 20 recent/live runs, with one shared 12 KiB encoded-output budget; whole lines only, omissions/counts explicit. No runtime CLI calls or historical completeness guarantee. Compose output is aggregate service buffers, not chronological; Kubernetes returns client diagnostics, not Pod logs. Optional service selects an exact declared Compose service's captured buffer, never parsed header text or the stack-network buffer; unavailable/legacy/other-runtime captures are explicit and never fall back to aggregate output. Choose exactly one app or infra ID; infra selects only immutable infrastructure-kind run snapshots, not app history relabelled by current configuration. Infrastructure is exclusively task-owned, not shared/external. No timestamp filter yet. The home orchestrator may inspect all host runs.",
				parameters: Type.Object({
					app: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
					infra: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
					grep: Type.Optional(Type.String({ maxLength: 512 })),
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
				name: "env_start",
				description:
					"Request human approval for exact configured run commands and acquire all explicitly named apps and task-owned infrastructure resources atomically in FIFO order. Infrastructure is run-only, exclusive, not shared/external. Declared same-repository requires are expanded through their configured default targets, bounded to 16 total projects, and started dependency-first. Dependency batches have coupled lifetimes: stopping or losing any member cleans up all members, not partial last-reference release. No implicit Kubernetes starts. Only this task's repository/workspace is allowed. An identical complete live plan held by this task returns an explicit already-held receipt without executing again or reapplying secrets/workspace content. Changed/partial/closing/interrupted/foreign plans are not reusable. Release an existing batch before acquiring different apps. Shell readiness uses optional readyText; containers require running state or configured engine health. Compose supports a limited file subset: Docker shared mode uses an owned bridge with service-name aliases; explicitly isolated mode has no shared network/DNS. Shared Podman networking is unavailable. Kubernetes requires an explicitly named target or runtime and an approved local context; only bare pods in an existing non-system namespace are supported, with optional bounded HTTP/TCP kubelet readiness probes and API Ready observations (not end-to-end application verification), live UID receipts and UID-preconditioned cleanup. Acquisition timeout releases queue position; no app starts on timeout.",
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
