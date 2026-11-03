import type {
	DigestCoverage,
	DigestEvidence,
	DigestPage,
} from "./daily-digest.ts";

/** Cumulative normalization ledger. It cannot certify collection reads it did not observe. */
export class DigestCollection {
	private readonly scopes = new Map<
		string,
		{
			source: string;
			scope: string;
			pages: number;
			inspected: number;
			next?: string;
			cursors: Set<string>;
			gaps: Set<string>;
			truncated: boolean;
		}
	>();
	private eventCount = 0;
	canNormalize(source: string, scope: string): boolean {
		const state = this.scopes.get(JSON.stringify([source, scope]));
		return (
			this.eventCount < 2000 &&
			(!!state || this.scopes.size < 1000) &&
			(!state ||
				(state.pages < 100 && state.inspected < 10000 && !state.truncated))
		);
	}
	record(
		source: string,
		scope: string,
		page: DigestPage<DigestEvidence> & { inspected: number },
		requestedCursor?: string,
	): void {
		const key = JSON.stringify([source, scope]);
		const state = this.scopes.get(key) ?? {
			source,
			scope,
			pages: 0,
			inspected: 0,
			cursors: new Set<string>(),
			gaps: new Set<string>(),
			truncated: false,
		};
		if (state.next !== requestedCursor) {
			state.gaps.add("pagination-request-cursor-unverified");
			state.truncated = true;
		}
		state.pages++;
		state.inspected += page.inspected;
		this.eventCount += page.items.length;
		for (const gap of page.missingFields ?? []) state.gaps.add(gap);
		for (const gap of page.diagnostics ?? []) state.gaps.add(gap);
		state.truncated ||= !!page.truncated;
		if (page.next && state.cursors.has(page.next)) {
			state.gaps.add("cursor-loop");
			state.truncated = true;
		}
		if (page.next) state.cursors.add(page.next);
		state.next = page.next;
		if (
			state.pages >= 100 ||
			state.inspected >= 10000 ||
			this.eventCount >= 2000
		) {
			state.gaps.add("cumulative-collection-cap");
			state.truncated = true;
		}
		this.scopes.set(key, state);
	}
	coverage(): DigestCoverage[] {
		return [...this.scopes.values()].map((state) => ({
			source: state.source,
			scope: state.scope,
			pages: state.pages,
			items: state.inspected,
			status:
				state.truncated || state.next || state.gaps.size
					? "partial"
					: "success",
			truncated: state.truncated,
			missingFields: [...state.gaps],
			diagnostics: state.next ? ["pagination-pages-remaining"] : [],
		}));
	}
}
