import type {
	EnvironmentMutation,
	EnvironmentRead,
} from "../../../protocol/environment-workbench.ts";
/** Field guides only, never executable payloads, approvals or default request identities. */
export const readFields: Record<EnvironmentRead, string> = {
	discovery: "repository, optional directory (configured repository only)",
	drafts: "No selection fields",
	draft: "id",
	trees: "No selection fields",
	preflights: "No selection fields",
	preflight: "id",
	promotions: "No selection fields",
	promotion: "id",
	attempts: "No selection fields",
	logs: "app, optional options: since/grep/tail/service/kind=infrastructure/replica",
	telemetry:
		"app, exact run, optional options: mode=traces|logs/view=flat|tree/cursor/traceId/spanId/http/service/rootKind/limit/since/status=all|error|success/name/severity/text. Requires a current native ready telemetry run; saved IDs are not adopted.",
	"http-history":
		"run, optional operation/cursor (native diagnostic journal only)",
	"database-history":
		"run, optional operation/cursor (native diagnostic journal only)",
};
export const mutationFields: Record<EnvironmentMutation, string> = {
	save: "requestId, content (inert definition JSON text); id and exact revision for edits only",
	"capture-base":
		"requestId, id, revision, app, target, sourceDigest, readBase=true, acceptCurrentBase=true (explicit source observation)",
	"save-source":
		"requestId, id, revision, app, target, content; auxiliary=true and relative file for auxiliary sources only",
	"remove-source":
		"requestId, id, revision; either bindingDigest or app/target, never both",
	"remove-draft":
		"requestId, id, revision; private staged draft/tree cleanup only",
	preflight:
		"requestId, id, revision, digest. At most one explicit true mode: readComposeSource/useStagedSource/compareSourceBase (app/target required), validateStagedCandidate, materializeStagedTree (optional retainStagedTree=true). Metadata-only when no mode is selected. Explicit source reads/tree assembly may have filesystem effects; validation gates remain native.",
	promote:
		"requestId, id, revision, digest, manually reviewed approve=digest; optional separately reviewed sourcesApprove. Native destination/base/tree/source fences still apply. Live definition publication, not app deployment/restart.",
	"release-tree": "requestId, name (exact retained tree digest)",
	"release-temporary-tree":
		"requestId, id (tree-cleanup assembly attempt), revision, fingerprint, remove=true; inspect trees first",
	"acknowledge-tree-cleanup":
		"requestId, id (tree-cleanup attempt), revision, acknowledge=true; inspect trees first",
	"acknowledge-attempt":
		"requestId, id (promotion attempt), acknowledge=true; never redispatches publication",
	revoke:
		"requestId, runId, exact positive revision, reason; stops current live owner handles only, never adopts interrupted IDs",
	"release-run":
		"id, exact positive revision, inspectionConfirmed=true; acknowledge separately inspected interrupted resources only",
};
