// Reads the result/report/heal evidence a `stage.replay` run's `stage_replay`
// call stored, plus the flow registry's block digests
// (`add-stage-flow-replay`). Runtime-layer so it may reach the evidence store
// and the stage-blocks flow registry directly; the pure `stage.replay` step
// behavior only consumes the already-decoded `StageReplayEvidence` this
// returns (`workflow/runtime/reducers/agent-handoff.ts`).
import fs from "node:fs";
import { listEvidence, openEvidenceFile } from "../../server/evidence/store.ts";
import { readFlowEntry } from "../../stage-blocks/flow-registry.ts";
import { workflowEvidenceScope } from "./evidence-store.ts";

export interface StageReplayEvidence {
	readonly result?: {
		readonly status?: unknown;
		readonly flowId?: unknown;
		readonly planId?: unknown;
		readonly revision?: unknown;
		readonly inputsHash?: unknown;
		readonly routeHash?: unknown;
		readonly steps?: readonly {
			readonly block?: unknown;
			readonly version?: unknown;
		}[];
	};
	readonly report?: unknown;
	readonly heal?: unknown;
	readonly resultEvidenceId?: string;
	readonly reportEvidenceId?: string;
	readonly healEvidenceId?: string;
	readonly blockDigests?: Readonly<Record<string, string>>;
}

function readEvidenceJson(
	scope: ReturnType<typeof workflowEvidenceScope>,
	caption: string,
): { readonly id: string; readonly value: unknown } | undefined {
	let entry: ReturnType<typeof listEvidence>["entries"][number] | undefined;
	try {
		entry = [...listEvidence(scope).entries]
			.reverse()
			.find((candidate) => candidate.caption === caption);
	} catch {
		return undefined;
	}
	if (entry === undefined) return undefined;
	const opened = openEvidenceFile(scope, entry);
	if (opened === undefined) return undefined;
	try {
		if (opened.size > 8 * 1024 * 1024) return undefined;
		const bytes = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = fs.readSync(
				opened.fd,
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (read === 0) break;
			offset += read;
		}
		return {
			id: entry.id,
			value: JSON.parse(bytes.subarray(0, offset).toString("utf8")),
		};
	} catch {
		return undefined;
	} finally {
		fs.closeSync(opened.fd);
	}
}

export function readStageReplayEvidence(
	scope: {
		readonly workflowId: string;
		readonly worktree: string;
		readonly definitionId: string;
	},
	flowId: string,
): StageReplayEvidence {
	const evidenceScope = workflowEvidenceScope(scope);
	const result = readEvidenceJson(
		evidenceScope,
		`Stage replay result for ${flowId}`,
	);
	const report = readEvidenceJson(
		evidenceScope,
		`Stage replay report for ${flowId}`,
	);
	const heal = readEvidenceJson(
		evidenceScope,
		`Stage heal packet for ${flowId}`,
	);
	let blockDigests: Record<string, string> | undefined;
	try {
		// One flow, read directly: this runs on the polled workflow read path, so
		// scanning (and hashing) every saved flow to find one of them is work that
		// grows with history rather than with the run (`PERF-102`).
		blockDigests = readFlowEntry(scope.worktree, flowId).entry?.manifest
			.blockDigests as Record<string, string> | undefined;
	} catch {
		/* the summary stays useful without the saved manifest */
	}
	return {
		...(result === undefined
			? {}
			: {
					result: result.value as StageReplayEvidence["result"],
					resultEvidenceId: result.id,
				}),
		...(report === undefined
			? {}
			: { report: report.value, reportEvidenceId: report.id }),
		...(heal === undefined
			? {}
			: { heal: heal.value, healEvidenceId: heal.id }),
		...(blockDigests === undefined ? {} : { blockDigests }),
	};
}
