// The stage picker's behaviour (`open-stage-from-environments`).
//
// One dialog, two steps: the allow-listed stages the server answered, then — for
// a stage with several `kind: "ui"` applications — the application to open.
// Selecting a stage with exactly one UI application opens it immediately, and an
// application linked to the table's selected row (`app` names a configured app
// ident) is offered first, so "open the stage for this app" is one Enter.
//
// Opening is local and read-only: the configured URL goes to the system browser
// and nothing else happens — no stage session, no login hand-off, no server
// mutation, nothing recorded. The catalog read is the only request, and it is the
// server's own allow-listed view, so an excluded file can never be listed here.
import type {
	StageAppStatus,
	StageStatus,
	StagesStatusResponse,
} from "@devenv/core";
import {
	type BrowserOpener,
	type BrowserOpenOutcome,
	openInSystemBrowser,
} from "./stage-open.ts";
import {
	clampIndex,
	filterStageApps,
	filterStages,
	isOpenableUrl,
	orderedStageApps,
	stageUiApps,
} from "./stage-picker-model.ts";

/** The one catalog read the picker needs, so a test can answer it. */
export interface StageCatalogReader {
	getStages(signal?: AbortSignal): Promise<StagesStatusResponse>;
}

/** The rows the link is resolved against: the table's filtered rows and the
 * cursor, exactly what the developer sees. */
export interface StageSelectionSource {
	tableFilteredApps(): readonly { readonly ident?: string }[];
	selectedIndex(): number;
}

/** The picker's slice of the UI store. Stated structurally so a test can hold
 * plain signals without a renderer. */
export interface StagePickerStore {
	showStagePicker(): boolean;
	setShowStagePicker(open: boolean): void;
	stagePickerStages(): StageStatus[];
	setStagePickerStages(stages: StageStatus[]): void;
	stagePickerLoading(): boolean;
	setStagePickerLoading(loading: boolean): void;
	stagePickerError(): string | null;
	setStagePickerError(error: string | null): void;
	stagePickerQuery(): string;
	setStagePickerQuery(query: string): void;
	stagePickerFilterActive(): boolean;
	setStagePickerFilterActive(active: boolean): void;
	stagePickerIndex(): number;
	setStagePickerIndex(index: number | ((previous: number) => number)): void;
	stagePickerStep(): "stages" | "apps";
	setStagePickerStep(step: "stages" | "apps"): void;
	stagePickerStage(): StageStatus | null;
	setStagePickerStage(stage: StageStatus | null): void;
	stagePickerApps(): StageAppStatus[];
	setStagePickerApps(apps: StageAppStatus[]): void;
	stagePickerAppIndex(): number;
	setStagePickerAppIndex(index: number | ((previous: number) => number)): void;
	setNotification(
		message: string,
		type?: "info" | "success" | "warning" | "error",
	): void;
}

export interface StageActionsDeps {
	uiStore: StagePickerStore;
	appStore: StageSelectionSource;
	client: StageCatalogReader;
	/** Injected by a test; the system browser opener otherwise. */
	open?: BrowserOpener;
	/** Upper bound of the catalog read. */
	timeoutMs?: number;
}

const READ_TIMEOUT_MS = 15_000;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The configured app ident the table's selection names, when it names one. */
export function selectedAppIdent(
	store: StageSelectionSource,
): string | undefined {
	const row = store.tableFilteredApps()[store.selectedIndex()];
	return row?.ident;
}

export function createStageActions(deps: StageActionsDeps) {
	const { uiStore, appStore, client } = deps;
	const open = deps.open ?? openInSystemBrowser;
	const timeoutMs = deps.timeoutMs ?? READ_TIMEOUT_MS;

	/** The stages the picker offers, filtered by the typed query. */
	const visibleStages = (): StageStatus[] =>
		filterStages(uiStore.stagePickerStages(), uiStore.stagePickerQuery());

	/** The applications the second step offers, filtered by the same query. */
	const visibleApps = (): StageAppStatus[] =>
		filterStageApps(uiStore.stagePickerApps(), uiStore.stagePickerQuery());

	const reset = () => {
		uiStore.setStagePickerStages([]);
		uiStore.setStagePickerError(null);
		uiStore.setStagePickerQuery("");
		uiStore.setStagePickerFilterActive(false);
		uiStore.setStagePickerIndex(0);
		uiStore.setStagePickerStep("stages");
		uiStore.setStagePickerStage(null);
		uiStore.setStagePickerApps([]);
		uiStore.setStagePickerAppIndex(0);
	};

	/** Read the catalog and show the picker. A failed read keeps the dialog open
	 * with the server's message: the picker is where "no server" is said. */
	const openStagePicker = async (): Promise<void> => {
		reset();
		uiStore.setStagePickerLoading(true);
		uiStore.setShowStagePicker(true);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const catalog = await client.getStages(controller.signal);
			uiStore.setStagePickerStages([...catalog.stages]);
			uiStore.setStagePickerError(null);
		} catch (error) {
			uiStore.setStagePickerStages([]);
			uiStore.setStagePickerError(message(error));
		} finally {
			clearTimeout(timer);
			uiStore.setStagePickerLoading(false);
		}
	};

	const close = (): void => {
		uiStore.setShowStagePicker(false);
		reset();
	};

	/** Move the cursor of the step that is showing. */
	const move = (delta: number): void => {
		if (uiStore.stagePickerStep() === "apps") {
			const length = visibleApps().length;
			uiStore.setStagePickerAppIndex((index) =>
				clampIndex(index + delta, length),
			);
			return;
		}
		uiStore.setStagePickerIndex((index) =>
			clampIndex(index + delta, visibleStages().length),
		);
	};

	/** Switch to the second step, or open the stage's only UI application. */
	const chooseStage = async (stage: StageStatus): Promise<void> => {
		const apps = orderedStageApps(
			stageUiApps(stage),
			selectedAppIdent(appStore),
		);
		if (apps.length === 0) {
			uiStore.setNotification(
				`No UI application configured for ${stage.displayName}`,
				"warning",
			);
			close();
			return;
		}
		if (apps.length === 1) {
			const [only] = apps;
			if (only) await openApp(stage, only);
			return;
		}
		uiStore.setStagePickerStage(stage);
		uiStore.setStagePickerApps(apps);
		uiStore.setStagePickerAppIndex(0);
		uiStore.setStagePickerQuery("");
		uiStore.setStagePickerStep("apps");
	};

	/** Hand one configured URL to the browser and say how it went. */
	const openApp = async (
		stage: StageStatus,
		app: StageAppStatus,
	): Promise<BrowserOpenOutcome> => {
		if (!isOpenableUrl(app.url)) {
			uiStore.setNotification(
				`${app.label} has no browser URL (${app.url})`,
				"error",
			);
			close();
			return { ok: false, reason: "not an http(s) URL" };
		}
		const outcome = await open(app.url);
		if (outcome.ok) {
			uiStore.setNotification(
				`Opened ${stage.displayName} · ${app.label} in the browser`,
				"success",
			);
		} else {
			uiStore.setNotification(
				`Could not open ${app.label}: ${outcome.reason ?? "the browser did not start"}`,
				"error",
			);
		}
		close();
		return outcome;
	};

	/** Enter: pick the stage, then the application. */
	const confirm = async (): Promise<void> => {
		if (uiStore.stagePickerLoading()) return;
		if (uiStore.stagePickerStep() === "apps") {
			const stage = uiStore.stagePickerStage();
			const app =
				visibleApps()[
					clampIndex(uiStore.stagePickerAppIndex(), visibleApps().length)
				];
			if (stage && app) await openApp(stage, app);
			return;
		}
		const stage =
			visibleStages()[
				clampIndex(uiStore.stagePickerIndex(), visibleStages().length)
			];
		if (!stage) return;
		await chooseStage(stage);
	};

	const setFilter = (query: string): void => {
		uiStore.setStagePickerQuery(query);
		uiStore.setStagePickerIndex(0);
		uiStore.setStagePickerAppIndex(0);
	};

	/** `/`: start filtering from an empty query; Escape clears it first. */
	const activateFilter = (): void => {
		uiStore.setStagePickerQuery("");
		uiStore.setStagePickerFilterActive(true);
	};

	const clearFilter = (): void => {
		uiStore.setStagePickerFilterActive(false);
		uiStore.setStagePickerQuery("");
		uiStore.setStagePickerIndex(0);
		uiStore.setStagePickerAppIndex(0);
	};

	return {
		openStagePicker,
		close,
		confirm,
		move,
		chooseStage,
		setFilter,
		activateFilter,
		clearFilter,
		visibleStages,
		visibleApps,
	};
}

export type StageActions = ReturnType<typeof createStageActions>;
