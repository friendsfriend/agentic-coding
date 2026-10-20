// Pure helpers of the stage picker (`open-stage-from-environments`).
//
// The picker shows the server's allow-listed catalog and, for one chosen stage,
// its `kind: "ui"` applications. Filtering, ordering and row labels are plain
// functions so the modal, the actions and their tests agree on exactly one
// definition of "the app this Enter opens".
import type { StageAppStatus, StageStatus } from "@devenv/core";

/** One row of the stage list, as the modal renders it. The access marker is the
 * stage's own (`read-only` / `writable`), never inferred from a probe. */
export function stageRowText(stage: StageStatus): string {
	return `${stage.displayName} · ${stage.ident} · ${stage.environment} · ${stage.access}`;
}

/** One row of the second step: the UI application's label and its URL. */
export function stageAppRowText(app: StageAppStatus): string {
	return `${app.label} · ${app.url}`;
}

/** The applications of a stage the picker may open: a UI application only. An
 * `api`, `mail-catcher` or `probe` entry has no page to show, so it is never a
 * choice here. */
export function stageUiApps(stage: StageStatus): StageAppStatus[] {
	return stage.apps.filter((app) => app.kind === "ui");
}

/**
 * The UI applications in the order the picker offers them: the one linked to the
 * table's selected application (`app` names a configured app ident) comes first,
 * so "open the stage for this app" is one Enter. The rest keep the stage's own
 * declaration order.
 */
export function orderedStageApps(
	apps: readonly StageAppStatus[],
	linkedApp?: string,
): StageAppStatus[] {
	if (!linkedApp) return [...apps];
	const linked = apps.filter((app) => app.app === linkedApp);
	return [...linked, ...apps.filter((app) => app.app !== linkedApp)];
}

/** Stage filtering: the display name, the ident and the environment are what a
 * developer types to find a stage. */
export function filterStages(
	stages: readonly StageStatus[],
	query: string,
): StageStatus[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...stages];
	return stages.filter((stage) =>
		[stage.displayName, stage.ident, stage.environment]
			.join("\n")
			.toLowerCase()
			.includes(needle),
	);
}

/** Application filtering of the second step: label and URL. */
export function filterStageApps(
	apps: readonly StageAppStatus[],
	query: string,
): StageAppStatus[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...apps];
	return apps.filter((app) =>
		[app.label, app.url].join("\n").toLowerCase().includes(needle),
	);
}

/** The selection index clamped to a list, so an empty list has no selection and
 * a filtered one can never point past its end. */
export function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

/**
 * Whether an application URL may be handed to the system browser. The catalog is
 * the server's, but the opener is a local process launch, so the scheme is
 * checked here as well: only `http:`/`https:` ever reach it. Everything else
 * stays in the TUI as an error line.
 */
export function isOpenableUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}
