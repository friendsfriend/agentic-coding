import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { text } from "../config.ts";
import { decode } from "../state.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
} from "./state.ts";

export type OperatorRevocation = {
	requestId: string;
	runId: string;
	revision: number;
	reason: string;
	owner: number;
	createdAt: number;
	state: "issued" | "completed" | "interrupted";
	inspectionRequired: boolean;
};
type Authority = {
	store: () => Harness;
	live: (run: EnvironmentRun) => boolean;
	latch: (owner: number) => void;
	release: (owner: number) => Promise<string | null>;
};

/** Authenticated developer-only authority; deliberately not an agent tool. */
export class OperatorRevocations {
	private cleanups = new Map<number, Promise<boolean>>();
	constructor(private authority: Authority) {}
	recover(doc: { operatorRevocations?: Record<string, string> }) {
		for (const [id, raw] of Object.entries(doc.operatorRevocations ?? {})) {
			const receipt = decode<OperatorRevocation>(raw);
			this.authority.latch(receipt.owner);
			if (receipt.state === "issued" && doc.operatorRevocations)
				doc.operatorRevocations[id] = JSON.stringify({
					...receipt,
					state: "interrupted",
					inspectionRequired: true,
				});
		}
	}
	async revoke(input: Record<string, unknown>) {
		if (
			Object.keys(input).some(
				(key) => !["requestId", "runId", "revision", "reason"].includes(key),
			)
		)
			throw new Error("Unexpected environment revocation field");
		const requestId = text(input.requestId, "request ID", 256),
			runId = text(input.runId, "run ID", 512),
			reason = text(input.reason, "revocation reason", 1000),
			revision = Number(input.revision);
		if (!Number.isSafeInteger(input.revision) || revision < 1)
			throw new Error("A current integer run revision is required");
		const receipt = await this.authority.store().commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState);
			doc.operatorRevocations ??= {};
			const previous = doc.operatorRevocations[requestId];
			if (previous) {
				const saved = decode<OperatorRevocation>(previous);
				if (
					saved.runId !== runId ||
					saved.revision !== revision ||
					saved.reason !== reason
				)
					throw new Error("Environment revocation request identity mismatch");
				return saved;
			}
			const raw = doc.runs[runId];
			if (!raw) throw new Error("Unknown environment run");
			const run = decode<EnvironmentRun>(raw);
			if (run.revision !== revision || !holdsResource(run))
				throw new Error("Stale environment revocation");
			if (run.state === "interrupted" || !this.authority.live(run))
				throw new Error(
					"No current live authority; inspect quarantined resources instead of adopting saved identities",
				);
			this.authority.latch(run.owner);
			const saved: OperatorRevocation = {
				requestId,
				runId,
				revision,
				reason,
				owner: run.owner,
				createdAt: Date.now(),
				state: "issued",
				inspectionRequired: false,
			};
			doc.operatorRevocations[requestId] = JSON.stringify(saved);
			return saved;
		}, background);
		if (receipt.state !== "issued") return receipt;
		// Only current handles are ever stopped. A reopened issued receipt is interrupted by recover().
		let cleanup = this.cleanups.get(receipt.owner);
		if (!cleanup) {
			cleanup = this.authority.release(receipt.owner).then(
				(result) => Boolean(result),
				() => true,
			);
			this.cleanups.set(receipt.owner, cleanup);
		}
		const inspectionRequired = await cleanup;
		return this.authority.store().commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				raw = doc.operatorRevocations?.[requestId];
			if (!raw)
				throw new Error("Missing revocation receipt; owner remains revoked");
			const saved = decode<OperatorRevocation>(raw);
			if (saved.state !== "issued") return saved;
			const completed: OperatorRevocation = {
				...saved,
				state: "completed",
				inspectionRequired,
			};
			if (doc.operatorRevocations)
				doc.operatorRevocations[requestId] = JSON.stringify(completed);
			return completed;
		}, background);
	}
}
