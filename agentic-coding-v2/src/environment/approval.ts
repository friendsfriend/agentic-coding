import { independentRoot, referencedRoot } from "./lifetime.ts";
import type { Plan } from "./model.ts";

/** Shared immutable disclosure for agent and direct operator execution. */
export function environmentApproval(
	plans: Plan[],
	timeoutSec: number,
	retainQueue = false,
) {
	const action = plans[0]?.action;
	return JSON.stringify(
		{
			plans,
			waitTimeoutMs: timeoutSec * 1000,
			...(retainQueue
				? {
						retainQueue: true,
						queueScope:
							"A bounded acquisition timeout retains this exact plan's FIFO place without reserving or starting apps between calls. Only this native owner may explicitly continue it through env_wait; changing apps/selection requires cancelling it and fresh approval. Matching env_stop, task completion/cancellation and host shutdown/restart invalidate the live queue entry. Saved queue and poll receipts are diagnostic only and never restore execution authority. Continuation wait durations may be 1..7200 seconds per call; they do not extend the native task lifetime.",
					}
				: {}),
			...(plans.some((plan) => plan.telemetry)
				? {
						telemetryScope:
							"Each explicitly configured shell telemetry target also starts one authenticated OTLP/HTTP JSON receiver on an OS-selected ephemeral 127.0.0.1 port, never a public/external receiver. The approved command and descendants receive AC_OTEL_APP, AC_OTEL_OWNER, AC_OTEL_RUN, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL=http/json, OTEL_EXPORTER_OTLP_HEADERS with a new private bearer credential, OTEL_RESOURCE_ATTRIBUTES and OTEL_METRICS_EXPORTER=none. These values cannot be overridden by target literals/references; this is not automatic instrumentation or an OS credential sandbox. Native scope is immutable regardless of resource claims; app telemetry is diagnostic data, not execution/review authority. Ingress is limited to four pending 64 KiB JSON requests with five-second body deadlines. Only bounded redacted in-memory traces/logs are retained and queried while the live ready run is held; no metrics, external backend, persisted token/buffer adoption or complete history. Returned redacted observations can remain in native task/chat history as diagnostic tool results, never restored receiver/buffer authority. Stop, startup cancellation, process exit and owner cleanup close admission, discard buffers and join listener closure before release; uncertain cleanup quarantines the app slot.",
					}
				: {}),
			...(plans.some((plan) => plan.kubernetes)
				? {
						kubernetesScope:
							"Bare pods only in the displayed existing non-system namespace and explicit local cluster. No cluster/namespace creation, Helm, controllers or host mounts; automatic service-account token mounting and privilege escalation are disabled in the requested pod spec. No existing pod adoption, even with matching labels. Only live creation UIDs and host/run labels authorize cleanup; DELETE uses live UID and observed resource-version preconditions, a five-second grace period and orphan propagation, never cascading namespace deletion. Declared environment values and resolved secret references are sent to the Kubernetes API as Pod env values, where authorized cluster readers can see them and the API can persist them. The local client receives them only on private stdin, not argv or manifest files; this is not Kubernetes Secret-object integration. All replicas are created before readiness waits. Only HTTP/TCP pod-local kubelet readiness probes are supported, with bounded timing and no exec/host/header overrides. HTTPS probes use kubelet semantics without certificate verification; TCP probes only test socket acceptance. Pod Ready without a probe is not application health. API-observed readiness loss after startup is reported unhealthy, not an automatic stop. Pod services are not yet supported; pod logs are limited to one owned replica and port forwards to declared loopback bindings. API/identity loss or uncertain writes quarantine the app slot. The configured image and commands can execute code and make network requests; this is not an OS sandbox.",
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
						dependencyScope: plans.every(referencedRoot)
							? "Declared owned infrastructure is acquired atomically with every requested app, at most 16 projects, and started dependency-first through each configured readiness observation. Referenced-roots-v1 keeps this one acquisition but not the coupled per-member stop: each app root is stopped or expires on its own scoped activity. A prerequisite is retained while any declared root still references it and is cleaned last-reference, dependent-first, through original live handles. Startup failure/cancellation still rolls back the complete new acquisition. Direct stop of a still-referenced prerequisite is refused. No cross-owner/task sharing, extra acquisitions, automatic restart, saved-ID adoption or backfill of older coupled batches."
							: "Declared owned infrastructure is acquired atomically with every requested app, at most 16 projects (Compose services and Pod replicas retain their own bounds), and started dependency-first through each configured readiness observation. This is one coupled-lifetime batch: stopping ANY member, ANY member exiting, startup failure, task cleanup or host shutdown stops ALL members, dependents before dependencies. No partial release, cross-task sharing, automatic restart or saved-ID adoption. Root target/profile/runtime options do not override automatic dependency defaults. Kubernetes dependencies must be explicitly requested with an eligible target/runtime, never implicitly started.",
					}
				: {}),
			...(action === "run"
				? {
						idleScope: plans.every(referencedRoot)
							? "Explicit referenced-roots-v1: agent-owned app roots on shell, Docker/Podman or Compose run targets, with their declared same-repository prerequisites, in one atomic acquisition. After complete startup, scoped activity, stop and idle expiry affect only the selected app root; a prerequisite is never expired by its own clock while a root references it, and is released only with its last reference, dependent-first through original live handles. Direct stop of a still-referenced prerequisite is refused. Startup failure/cancellation rolls back the complete new acquisition. Uncertain root or prerequisite cleanup retains its references and quarantines the generation; inspection is required and grants no saved-ID control. Owner-wide list/unfiltered status renews that owner's roots; passive dashboard/history reads and dependency logs do not. Idle policy defaults to 30 minutes and re-reads config.json:environment.instances.idle_ttl_minutes on throttled 60-second sweeps, with unusable-policy fallback. Kubernetes resources, foreign/shared external infrastructure, mixed modes, cross-owner sharing, additional held acquisitions and restart adoption are refused. This mode does not upgrade existing coupled approvals."
							: plans.every(independentRoot)
								? "Explicit independent-roots-v1: only agent-owned standalone app roots on shell, Docker/Podman or Compose run targets. All named roots are reserved and started atomically; startup failure/cancellation rolls back the complete new acquisition. After complete startup, scoped activity, stop and idle expiry affect only the selected root, not sibling roots or their live diagnostics. Owner-wide list/unfiltered status renews all roots; passive dashboard/history reads do not. Idle policy defaults to 30 minutes and re-reads config.json:environment.instances.idle_ttl_minutes on throttled 60-second sweeps, with unusable-policy fallback. Dependencies, shared references, operator mode and Kubernetes resources are unsupported. No second held run acquisition or expired-sibling reacquisition while another root remains held. Fresh approval and confirmed release are required for new acquisition. Unknown/interrupted roots and in-flight operations are protected; uncertain cleanup remains quarantined. No saved-ID adoption, restart-restored activity or execution authority, coding cancellation or permanent owner revocation from expiry. This mode does not upgrade existing coupled approvals."
								: "Agent-owned live batches also expire after owner-scoped environment inactivity (30 minutes by default). The file-only environment.instances.idle_ttl_minutes policy in config.json is re-read every 60 seconds; an unusable policy falls back to 30 minutes. All held runs in this native task's complete exclusive acquisition batch share one activity clock, including unrelated apps. Any member activity renews all of them. A second run acquisition batch is refused until existing holdings are released; an identical complete live-plan reuse adds no lease. This is not independent per-app inactivity or shared-reference expiry. Operator-owned and unknown/interrupted owners, owners waiting for another environment acquisition, and environment operations in flight are protected. Idle cleanup uses normal live-owned reverse cleanup, never saved IDs; uncertain cleanup remains quarantined. Operator dashboard reads do not renew agent activity, and expiry does not cancel the coding task or permanently revoke its environment authority.",
						reuseScope:
							"An identical complete live run plan already held by this same task may return an explicit already-held receipt instead of running again. No additional lease or command, secret re-resolution, changed workspace content application or readiness restart is implied. A changed, partial, closing, interrupted or foreign-owned plan cannot be reused. Saved reuse receipts are references only and never restore process/network/cleanup authority after restart.",
					}
				: {}),
			authority:
				"Execute these exact configured environment actions in the task workspace. Container clients use only the explicit local API socket, never the default or a remote daemon context. Named containers are never adopted; only resources created by this live operation with matching host/run labels may be stopped or removed. Container build artifacts can persist in the local engine. Not an OS sandbox. Only conventional PATH/HOME/LANG/TMPDIR/TERM plus the displayed literal variables, referenced secrets, WORKSPACE and CONFIG_DIR" +
				(plans.some((plan) => plan.telemetry)
					? ", plus the explicitly disclosed telemetryScope variables"
					: "") +
				" are passed. Run targets last until stopped, task completion/cancellation, agent idle expiry described in idleScope, or host shutdown. No automatic replay after ambiguous interruption.",
		},
		null,
		2,
	);
}
