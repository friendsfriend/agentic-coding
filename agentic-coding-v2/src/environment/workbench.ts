import { digest, text } from "../config.ts";
import type {
	EnvironmentCandidate,
	EnvironmentInspection,
	EnvironmentIntention,
} from "../protocol/environment-workbench.ts";
import {
	environmentMutations,
	environmentReads,
} from "../protocol/environment-workbench.ts";
import { record } from "../protocol/index.ts";
import type { Runtime } from "../runtime.ts";
import type { LogOptions } from "./logs.ts";
import type { TelemetryOptions } from "./model.ts";

function checkedOptions(body: Record<string, unknown>) {
	for (const [key, value] of Object.entries(body)) {
		if (key === "tail" || key === "limit" || key === "replica") {
			if (
				!Number.isSafeInteger(value) ||
				Number(value) < 0 ||
				Number(value) > 1000
			)
				throw new Error("Invalid diagnostic count");
		} else if (typeof value !== "string" || value.length > 512)
			throw new Error("Invalid diagnostic selector");
	}
}
function fields(body: Record<string, unknown>, names: string[]) {
	if (Object.keys(body).some((key) => !names.includes(key)))
		throw new Error("Unsupported environment field");
}
/** Typed gateway adapter, not a second environment engine. All native revision,
 * ownership, inspection and exact promotion approvals remain mandatory. */
export class EnvironmentWorkbench {
	private candidates = new Map<string, EnvironmentCandidate>();
	constructor(private app: Runtime) {}
	async inspect(input: EnvironmentInspection) {
		fields(record(input), ["operation", "selection"]);
		if (!environmentReads.includes(input.operation))
			throw new Error("Unknown environment read");
		const selection = record(input.selection),
			env = this.app.environments;
		const id = () => text(selection.id, "native record identity", 128);
		switch (input.operation) {
			case "discovery":
				fields(selection, ["repository", "directory"]);
				return env.discover(
					text(selection.repository, "repository", 4096),
					undefined,
					selection.directory === undefined
						? "."
						: text(selection.directory, "directory", 4096),
				);
			case "draft":
			case "preflight":
			case "promotion":
				fields(selection, ["id"]);
				return input.operation === "draft"
					? env.drafts.read(id())
					: input.operation === "preflight"
						? env.drafts.report(id())
						: env.drafts.promotion(id());
			case "logs": {
				fields(selection, ["app", "options"]);
				const options =
					selection.options === undefined ? {} : record(selection.options);
				fields(options, [
					"since",
					"grep",
					"tail",
					"service",
					"kind",
					"replica",
				]);
				checkedOptions(options);
				if (options.kind !== undefined && options.kind !== "infrastructure")
					throw new Error("Invalid log kind");
				return env.selectedLogs(
					text(selection.app, "app", 64),
					undefined,
					options as LogOptions,
				);
			}
			case "telemetry": {
				fields(selection, ["app", "run", "options"]);
				const options =
					selection.options === undefined ? {} : record(selection.options);
				fields(options, [
					"mode",
					"view",
					"cursor",
					"traceId",
					"spanId",
					"http",
					"service",
					"rootKind",
					"limit",
					"since",
					"status",
					"name",
					"severity",
					"text",
				]);
				checkedOptions(options);
				if (
					(options.mode !== undefined &&
						!["traces", "logs"].includes(String(options.mode))) ||
					(options.view !== undefined &&
						!["flat", "tree"].includes(String(options.view))) ||
					(options.status !== undefined &&
						!["all", "error", "success"].includes(String(options.status)))
				)
					throw new Error("Invalid telemetry selector");
				return env.queryTelemetry(
					text(selection.app, "app", 64),
					undefined,
					options as TelemetryOptions,
					text(selection.run, "run", 128),
				);
			}
			case "http-history":
			case "database-history": {
				fields(selection, ["run", "operation", "cursor"]);
				const options = {
					operation:
						selection.operation === undefined
							? undefined
							: text(selection.operation, "diagnostic operation", 128),
					cursor:
						selection.cursor === undefined
							? undefined
							: text(selection.cursor, "cursor", 64),
				};
				return (
					input.operation === "http-history" ? env.http : env.database
				).history(text(selection.run, "run", 128), options);
			}
			default:
				fields(selection, []);
				return input.operation === "drafts"
					? env.drafts.list()
					: input.operation === "trees"
						? env.drafts.trees()
						: input.operation === "preflights"
							? env.drafts.preflights()
							: input.operation === "promotions"
								? env.drafts.promotions()
								: env.drafts.attempts();
		}
	}
	preview(input: EnvironmentIntention): EnvironmentCandidate {
		fields(record(input), ["operation", "body"]);
		if (!environmentMutations.includes(input.operation))
			throw new Error("Unknown environment mutation");
		record(input.body);
		const snapshot = JSON.stringify(input);
		if (Buffer.byteLength(snapshot) > 96000)
			throw new Error("Environment intention oversized");
		for (const [id, candidate] of this.candidates)
			if (candidate.expiresAt <= Date.now()) this.candidates.delete(id);
		if (this.candidates.size >= 16)
			throw new Error("Environment candidate capacity reached");
		const candidate = {
			id: crypto.randomUUID(),
			digest: digest(snapshot),
			snapshot,
			expiresAt: Date.now() + 600000,
		};
		this.candidates.set(candidate.id, candidate);
		return { ...candidate };
	}
	async apply(id: string, approval: string) {
		const candidate = this.candidates.get(id);
		if (
			!candidate ||
			candidate.expiresAt <= Date.now() ||
			approval !== `approve:${candidate.digest}`
		)
			throw new Error("Exact unexpired environment confirmation required");
		// Consume before every native call, including validation failure. No retry,
		// reconnect, navigation or restored view can execute this intention again.
		this.candidates.delete(id);
		const { operation, body } = JSON.parse(
			candidate.snapshot,
		) as EnvironmentIntention;
		const env = this.app.environments,
			drafts = env.drafts;
		switch (operation) {
			case "save":
				return drafts.save(body);
			case "capture-base":
				return drafts.captureBase(body);
			case "save-source":
				return drafts.saveSource(body);
			case "remove-source":
				return drafts.removeSource(body);
			case "remove-draft":
				return drafts.removeDraft(body);
			case "preflight":
				return drafts.preflight(body);
			case "promote":
				return drafts.promote(body);
			case "release-tree":
				return drafts.releaseTree(body);
			case "release-temporary-tree":
				return drafts.releaseTemporaryTree(body);
			case "acknowledge-tree-cleanup":
				return drafts.acknowledgeTreeCleanup(body);
			case "acknowledge-attempt":
				return drafts.acknowledgeAttempt(body);
			case "stop-unit":
				return env.stopOperatorUnit(body);
			case "revoke":
				return env.operator.revoke(body);
			case "release-run":
				fields(body, ["id", "revision", "inspectionConfirmed"]);
				if (
					body.inspectionConfirmed !== true ||
					!Number.isSafeInteger(body.revision) ||
					Number(body.revision) < 1
				)
					throw new Error("Exact inspection and revision required");
				await env.acknowledge(text(body.id, "run", 128), Number(body.revision));
				return { acknowledged: true };
		}
	}
}
