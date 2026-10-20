// The stage catalog the independent-work creation form picks from
// (add-stage-test-launch, task 1.1).
//
// A stage test runs on exactly one allow-listed stage, so the form must never
// offer a stage the server would refuse: the picker reads the same
// `GET /api/v1/stages` the Settings section reads — over the connected server
// when the shell has one, from the in-process module when it does not — and
// keeps the refused files beside the allow-listed stages, so a stage that is
// missing from the picker can say why instead of looking unconfigured.
//
// Nothing here returns a credential value: the catalog carries names and
// presence only, and the picker renders a label and a diagnostic.
import { createCustomFetch } from "@devenv/core/src/custom-fetch.ts";
import type {
	ExcludedStageStatus,
	StageStatus,
	StagesStatusResponse,
} from "../../contracts/stages.ts";
import { backendClient } from "../../server/client.ts";
import { stagesStatus as inProcessStagesStatus } from "../../server/stages/operations.ts";

/** Last catalog read; undefined before the first refresh. */
let cached: StagesStatusResponse | undefined;
/** Message from the most recent failed read. */
let lastError: string | undefined;
/** Write generation: only the newest read — or a clear — may commit module
 * state. The stage step starts a read every time it is entered, so an earlier
 * read can answer after a later one; without this guard the abandoned read
 * would overwrite the newer snapshot, or resurrect one after a clear. */
let generation = 0;

/** How long one catalog read may take: the form must not sit on a request that
 * never answers, and an aborted read is a notice with a message, not a hang. */
const STAGE_CATALOG_TIMEOUT_MS = 15_000;

export function stageCatalogSnapshot(): StagesStatusResponse | undefined {
	return cached;
}

/** The last read that committed its result: the module's own state seam, for a
 * surface that renders the committed catalog rather than one read's answer. */
export function lastStageCatalogError(): string | undefined {
	return lastError;
}

/** One read's own answer. The error travels with the snapshot instead of being
 * read back from module state afterwards: an abandoned read must not report the
 * newest read's failure, and the newest read's failure must not be lost because
 * an older one committed nothing. */
export interface StageCatalogRead {
	readonly snapshot?: StagesStatusResponse;
	readonly error?: string;
}

/** Drop the cached snapshot (tests, and a configuration-root switch). Also
 * retires every read in flight: a read that started before the clear must not
 * commit the previous root's stages afterwards. */
export function clearStageCatalogSnapshot(): void {
	generation++;
	cached = undefined;
	lastError = undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read the whole catalog, allow-listed stages and refused files. A failed read
 * answers no snapshot and its own message, so the form reports that it could not
 * read the stages rather than showing an older list as if it were current. */
export async function refreshStageCatalog(): Promise<StageCatalogRead> {
	const mine = ++generation;
	const baseUrl = backendClient()?.baseUrl;
	let snapshot: StagesStatusResponse | undefined;
	let failure: string | undefined;
	try {
		if (!baseUrl) {
			snapshot = inProcessStagesStatus();
		} else {
			const response = await createCustomFetch()(`${baseUrl}/api/v1/stages`, {
				signal: AbortSignal.timeout(STAGE_CATALOG_TIMEOUT_MS),
			});
			const parsed = (await response.json().catch(() => undefined)) as
				| { ok?: boolean; value?: unknown; error?: { message?: string } }
				| undefined;
			if (!response.ok || !parsed || parsed.error)
				throw new Error(
					parsed?.error?.message ?? `stages unavailable (${response.status})`,
				);
			snapshot = parsed.value as StagesStatusResponse;
		}
	} catch (error) {
		failure = message(error);
	}
	// Only the newest read may write the module state; every read still answers
	// its own caller with what that read actually saw.
	if (mine === generation) {
		cached = snapshot;
		lastError = failure;
	}
	return snapshot
		? { snapshot }
		: { error: failure ?? "the stage catalog could not be read" };
}

/** One entry of the form's stage picker: an allow-listed stage that submits its
 * ident, or a refused file that stays visible with its first diagnostic and
 * cannot be selected. */
export interface StageChoice {
	readonly kind: "stage";
	/** Stable identity of the entry, so the cursor survives a re-read. */
	readonly key: string;
	/** The value the form submits; empty for a refused file. */
	readonly ident: string;
	readonly label: string;
	readonly detail: string;
	/** Why the entry cannot be selected; absent on an allow-listed stage. */
	readonly reason?: string;
}

/** The step's own empty state: with nothing configured there is no stage to
 * test, and submitting a start the server would refuse helps nobody. */
export const STAGE_CATALOG_EMPTY =
	"No stage is configured — add a stage under the configuration's stages directory; a stage test runs on one allow-listed stage.";

/** The detail line of an allow-listed stage: what it is, then the access marker
 * the developer has to see before planning anything that writes. */
function stageDetail(stage: StageStatus): string {
	return [stage.environment, stage.access]
		.filter((part) => Boolean(part))
		.join(" · ");
}

const ALLOW_LISTED = (stage: StageStatus): StageChoice => ({
	kind: "stage",
	key: `stage:${stage.ident}`,
	ident: stage.ident,
	label: stage.displayName?.trim() ? stage.displayName : stage.ident,
	detail: stageDetail(stage),
});

/** A refused file: its first diagnostic is the reason, and the ident it claims
 * is what a developer recognizes in the configuration. */
const REFUSED = (excluded: ExcludedStageStatus): StageChoice => {
	const diagnostic = excluded.diagnostics[0] ?? "no diagnostic was reported";
	return {
		kind: "stage",
		key: `excluded:${excluded.file}`,
		ident: "",
		label: excluded.ident ?? excluded.file,
		detail: diagnostic,
		reason: diagnostic,
	};
};

/**
 * The picker's entries in catalog order: allow-listed stages first, then the
 * files that were refused. An empty result means nothing is configured (or
 * nothing matched the filter), which the caller distinguishes with the raw
 * snapshot — `undefined` is a read that has not answered, `[]` is a catalog with
 * no stage at all.
 */
export function stageChoices(
	snapshot: StagesStatusResponse | undefined,
): StageChoice[] {
	if (!snapshot) return [];
	return [
		...snapshot.stages.map(ALLOW_LISTED),
		...snapshot.excluded.map(REFUSED),
	];
}

/** Whether the picked entry can start a workflow. */
export function stageChoiceSelectable(choice: StageChoice): boolean {
	return choice.reason === undefined;
}

/** The refusal the form shows when the cursor's entry cannot be selected. The
 * diagnostic is the actionable half — it names the field and the rule that
 * failed — so the refusal leads with the reason instead of repeating the
 * remedy the picker already offers (Esc back, pick another entry). */
export function stageChoiceRefusal(choice: StageChoice): string {
	return `${choice.label} is not in the allow-list — ${choice.reason ?? "no diagnostic was reported"}`;
}
