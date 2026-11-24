import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { type EnvironmentStreamEvent, errorMessage } from "../client.ts";
import type { EnvironmentMcpClient } from "./client.ts";
import {
	appsForTab,
	defaultTarget,
	type EnvironmentApp,
	type EnvironmentService,
	type EnvironmentStatus,
	type EnvironmentTab,
	type EnvironmentTarget,
	type EnvironmentView,
	type ExecutionReceipt,
	filterApps,
	type GitChanges,
	type GitDiff,
	type GitStatus,
	type LogsSnapshot,
	type OperationDetail,
	type OperationSubject,
	type OperationSummary,
	type OwnedResource,
	ownedFor,
	scopeLabel,
	shortId,
	TAB_ORDER,
	type TelemetrySnapshot,
	type TelemetryTrace,
	tabCounts,
	targetsFor,
} from "./model.ts";

export function createEnvironmentStore(client: EnvironmentMcpClient) {
	const [apps, setApps] = createSignal<readonly EnvironmentApp[]>([]);
	const [services, setServices] = createSignal<readonly EnvironmentService[]>(
		[],
	);
	const [repositories, setRepositories] = createSignal<readonly string[]>([]);
	const [status, setStatus] = createSignal<EnvironmentStatus>({});
	const [git, setGit] = createSignal<ReadonlyMap<string, GitStatus>>(new Map());
	const [changes, setChanges] = createSignal<GitChanges>();
	const [changeIndex, setChangeIndex] = createSignal(0);
	const [diff, setDiff] = createSignal<GitDiff>();
	const [operations, setOperations] = createSignal<readonly OperationSummary[]>(
		[],
	);
	const [operationTotal, setOperationTotal] = createSignal(0);
	const [operation, setOperation] = createSignal<OperationDetail>();
	const [progress, setProgress] = createSignal("");
	const [receipt, setReceipt] = createSignal<ExecutionReceipt | null>(null);
	const [logs, setLogs] = createSignal<LogsSnapshot>();
	const [telemetry, setTelemetry] = createSignal<TelemetrySnapshot>();
	const [traceId, setTraceId] = createSignal<string>();
	const [tab, setTab] = createSignal<EnvironmentTab>("applications");
	const [view, setView] = createSignal<EnvironmentView>("table");
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const [selectedAppId, setSelectedAppId] = createSignal<string>();
	const [targetAction, setTargetAction] = createSignal("run");
	const [targetIndex, setTargetIndex] = createSignal(0);
	const [historyIndex, setHistoryIndex] = createSignal(0);
	const [traceIndex, setTraceIndex] = createSignal(0);
	const [query, setQuery] = createSignal("");
	const [searchFocused, setSearchFocused] = createSignal(false);
	const [message, setMessage] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal(false);
	const [operationOrigin, setOperationOrigin] = createSignal<
		"detail" | "history"
	>("detail");
	const subjects = new Map<string, OperationSubject>();

	const fail = (reason: unknown) => {
		const text = errorMessage(reason);
		setError(text);
		setMessage(text);
	};
	const clearMessage = () => {
		setError(undefined);
		setMessage(undefined);
	};

	const counts = createMemo(() => tabCounts(apps()));
	const tabApps = createMemo(() => appsForTab(apps(), tab()));
	const filteredApps = createMemo(() => filterApps(tabApps(), query()));
	const selectedApp = createMemo(() => {
		const id = selectedAppId();
		return (
			filteredApps().find((app) => app.id === id) ??
			filteredApps()[selectedIndex()] ??
			tabApps()[0]
		);
	});
	const targetList = createMemo(() =>
		targetsFor(selectedApp(), targetAction()),
	);
	const selectedTarget = createMemo(
		() => targetList()[targetIndex()] ?? targetList()[0],
	);
	const owned = createMemo(() => status().owned ?? []);
	const selectedOwned = createMemo(() => {
		const app = selectedApp();
		return app ? ownedFor(status(), app.id) : ([] as readonly OwnedResource[]);
	});
	const selectedOperation = createMemo(
		() => operations()[historyIndex()] ?? operations()[0],
	);
	const selectedChange = createMemo(
		() => changes()?.changes[changeIndex()] ?? changes()?.changes[0],
	);
	const activeApps = createMemo(() => {
		const map = new Map<string, { action?: string }>();
		const current = operation();
		const candidates = current ? [current, ...operations()] : operations();
		for (const candidate of candidates) {
			const app = candidate.subject?.app;
			if (!app || candidate.state !== "issued" || map.has(app)) continue;
			map.set(app, { action: candidate.subject?.action });
		}
		return map;
	});
	const selectedTrace = createMemo<TelemetryTrace | undefined>(
		() => telemetry()?.traces[traceIndex()] ?? telemetry()?.traces[0],
	);
	const scope = createMemo(() => scopeLabel(status()));
	const appTotal = createMemo(() => apps().length);

	createEffect(() => {
		const count = filteredApps().length;
		setSelectedIndex((current) => Math.min(current, Math.max(0, count - 1)));
	});

	const loadStatus = async () => {
		setStatus(await client.status());
	};
	const loadGit = async (repositories?: readonly string[]) => {
		try {
			const statuses = await client.git(repositories);
			if (repositories?.length) {
				const next = new Map(git());
				for (const entry of statuses) next.set(entry.repository, entry);
				setGit(next);
			} else {
				setGit(new Map(statuses.map((entry) => [entry.repository, entry])));
			}
		} catch {
			// Keep the last observation; the explicit refresh reports errors.
		}
	};
	const applyHistory = (result: Awaited<ReturnType<typeof client.history>>) => {
		setOperations(result.operations);
		setOperationTotal(result.total);
		setHistoryIndex((current) =>
			Math.min(current, Math.max(0, result.operations.length - 1)),
		);
	};
	const loadHistory = async () => {
		applyHistory(await client.history(0, 20));
	};
	const maxLiveOutput = 8 * 1024 * 1024;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollToken: object | undefined;
	let pollingId: string | undefined;
	const stopPolling = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		pollToken = undefined;
		pollingId = undefined;
	};
	const pollOperation = (id: string) => {
		stopPolling();
		const token = {};
		pollToken = token;
		pollingId = id;
		let offset = 0;
		let buffered = "";
		const tick = async () => {
			if (pollToken !== token) return;
			try {
				const detail = await client.operation(id, offset);
				if (pollToken !== token) return;
				setError(undefined);
				setOperation(detail);
				if (detail.progress) {
					buffered = detail.progress.reset
						? detail.progress.text
						: buffered + detail.progress.text;
					if (buffered.length > maxLiveOutput)
						buffered = buffered.slice(buffered.length - maxLiveOutput);
					offset = detail.progress.offset;
					setProgress(buffered);
				}
				if (detail.state !== "issued") {
					stopPolling();
					setMessage(
						detail.state === "completed"
							? "Operation completed"
							: `Operation ${detail.state}`,
					);
					await loadHistory();
					await loadStatus();
					await loadGit();
					return;
				}
			} catch (reason) {
				if (pollToken !== token) return;
				fail(reason);
				stopPolling();
				return;
			}
			pollTimer = setTimeout(() => void tick(), 1000);
		};
		pollTimer = setTimeout(() => void tick(), 250);
	};
	const liveStatusRefreshMs = 15_000;
	const liveGitRefreshMs = 30_000;
	let liveStatusTimer: ReturnType<typeof setInterval> | undefined;
	let liveGitTimer: ReturnType<typeof setInterval> | undefined;
	let liveToken: object | undefined;
	let stateRequest = 0;
	let stateGeneration = 0;
	const refreshState = async () => {
		const request = ++stateRequest;
		try {
			const [nextStatus, history] = await Promise.all([
				client.status(),
				client.history(0, 20),
			]);
			if (request !== stateRequest) return;
			setStatus(nextStatus);
			applyHistory(history);
		} catch {
			// Keep the last observation; manual refresh reports errors.
		}
	};
	const stopLiveRefresh = () => {
		if (liveStatusTimer) clearInterval(liveStatusTimer);
		if (liveGitTimer) clearInterval(liveGitTimer);
		liveStatusTimer = undefined;
		liveGitTimer = undefined;
		liveToken = undefined;
	};
	const startLiveRefresh = () => {
		if (liveToken) return;
		const token = {};
		liveToken = token;
		if (loadedOnce) {
			void refreshState();
			void loadGit();
		}
		liveStatusTimer = setInterval(
			() => void refreshState(),
			liveStatusRefreshMs,
		);
		liveGitTimer = setInterval(() => void loadGit(), liveGitRefreshMs);
	};
	let snapshotCount = 0;
	const handleEvent = (event: EnvironmentStreamEvent) => {
		if (
			event.type === "status" ||
			event.type === "operation" ||
			event.type === "git"
		)
			stateGeneration += 1;
		if (event.type === "status" || event.type === "operation") {
			if (view() === "table" || view() === "detail") void refreshState();
			return;
		}
		if (event.type === "git") {
			void loadGit(event.repository ? [event.repository] : undefined);
			return;
		}
		if (event.type === "services") {
			void client
				.services()
				.then(setServices)
				.catch(() => {});
			return;
		}
		if (event.type === "snapshot") {
			snapshotCount += 1;
			if (snapshotCount === 1) return;
			if (loadedOnce && !busy()) void load();
		}
	};
	onCleanup(() => {
		stopPolling();
		stopLiveRefresh();
	});

	let loadedOnce = false;
	const load = async () => {
		setBusy(true);
		setError(undefined);
		const generation = stateGeneration;
		try {
			const [list, nextStatus, history] = await Promise.all([
				client.list(),
				client.status(),
				client.history(0, 20),
			]);
			setApps(list.apps);
			setServices(list.services);
			setRepositories(list.repositories);
			setStatus(nextStatus);
			setOperations(history.operations);
			setOperationTotal(history.total);
			void loadGit();
			if (!selectedAppId() && list.apps[0]) setSelectedAppId(list.apps[0].id);
			setSelectedIndex((current) =>
				Math.min(current, Math.max(0, filteredApps().length - 1)),
			);
			if (stateGeneration !== generation) {
				await refreshState();
				await loadGit();
			}
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
			loadedOnce = true;
		}
	};

	const selectTab = (next: EnvironmentTab) => {
		setTab(next);
		setQuery("");
		setSelectedIndex(0);
		setSearchFocused(false);
		clearMessage();
		if (next === "history") {
			setView("history");
			void loadHistory().catch(fail);
			return;
		}
		if (next === "services") {
			setView("services");
			void client.services().then(setServices).catch(fail);
			return;
		}
		setView("table");
	};

	const cycleTab = (delta: number) => {
		const index = TAB_ORDER.indexOf(tab());
		const next =
			TAB_ORDER[(index + delta + TAB_ORDER.length) % TAB_ORDER.length];
		if (next) selectTab(next);
	};

	const move = (delta: number) => {
		if (view() === "table") {
			const count = filteredApps().length;
			if (!count) return;
			setSelectedIndex((current) => (current + delta + count) % count);
			return;
		}
		if (view() === "targets") {
			const count = targetList().length;
			if (!count) return;
			setTargetIndex((current) => (current + delta + count) % count);
			return;
		}
		if (view() === "history") {
			const count = operations().length;
			if (!count) return;
			setHistoryIndex((current) => (current + delta + count) % count);
			return;
		}
		if (view() === "telemetry") {
			const count = telemetry()?.traces.length ?? 0;
			if (!count) return;
			setTraceIndex((current) => (current + delta + count) % count);
		}
	};

	const openApp = (app: EnvironmentApp) => {
		setSelectedAppId(app.id);
		setChanges(undefined);
		setDiff(undefined);
		setChangeIndex(0);
		setView("detail");
		clearMessage();
	};

	const executeTarget = async (action: string, target: EnvironmentTarget) => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			const result = await client.execute(app.id, target.id);
			const next = result.operation;
			if (!next) throw new Error("invalid-operation-response");
			subjects.set(next.id, {
				app: app.id,
				target: target.id,
				action,
				repository: app.repository,
			});
			setOperation(next);
			setReceipt(result.receipt);
			setProgress("");
			setOperationOrigin("detail");
			setView("operation");
			setMessage(`Executing ${app.id} · ${action} · ${target.id}`);
			if (next.state === "issued") {
				setMessage(`Running ${app.id} · ${action}…`);
				pollOperation(next.id);
			} else if (result.receipt) {
				setMessage(`Completed: ${String(result.receipt.status ?? "done")}`);
			}
			await loadHistory();
			await loadStatus();
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const loadChanges = async (app: EnvironmentApp) => {
		setBusy(true);
		setError(undefined);
		try {
			setChanges(await client.gitChanges(app.repository));
			setChangeIndex(0);
			setDiff(undefined);
			setView("changes");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const refreshChanges = async () => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			const next = await client.gitChanges(app.repository);
			setChanges(next);
			setChangeIndex((current) =>
				Math.min(current, Math.max(0, next.changes.length - 1)),
			);
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const openSelectedChange = async () => {
		const app = selectedApp();
		const change = selectedChange();
		if (!app || !change) return;
		setBusy(true);
		setError(undefined);
		try {
			setDiff(await client.gitDiff(app.repository, change.path));
			setView("diff");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const reloadDiff = async () => {
		const app = selectedApp();
		const current = diff();
		if (!app || !current) return;
		setBusy(true);
		setError(undefined);
		try {
			setDiff(await client.gitDiff(app.repository, current.path));
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const moveChange = (delta: number) => {
		const count = changes()?.changes.length ?? 0;
		if (!count) return;
		setChangeIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};

	const openTargets = (action: string) => {
		const app = selectedApp();
		if (!app) return;
		const targets = targetsFor(app, action);
		if (!targets.length) {
			setMessage(`No ${action} target configured for ${app.id}.`);
			return;
		}
		setTargetAction(action);
		setTargetIndex(0);
		if (targets.length === 1) {
			const target = targets[0];
			if (target) void executeTarget(action, target);
			return;
		}
		setView("targets");
	};

	const refreshOperation = async () => {
		const current = operation();
		if (!current) return;
		setBusy(true);
		setError(undefined);
		try {
			const next = await client.operation(current.id);
			setOperation(next);
			setMessage(`Operation ${next.state}`);
			if (next.state === "issued" && pollingId !== next.id)
				pollOperation(next.id);
			await loadHistory();
			await loadStatus();
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const stop = async () => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			const result = await client.stop(app.id);
			setMessage(
				`Stopped ${result.stopped.length} resource${result.stopped.length === 1 ? "" : "s"}; ${result.remaining} remaining`,
			);
			await loadStatus();
			await loadHistory();
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const loadLogs = async (app: EnvironmentApp) => {
		setBusy(true);
		setError(undefined);
		try {
			setLogs(await client.logs(app.id, 200));
			setView("logs");
		} catch (reason) {
			const code = errorMessage(reason);
			const text =
				code === "operation-unavailable"
					? `No owned logs or retained output for ${app.id}.`
					: code;
			setError(text);
			setMessage(text);
		} finally {
			setBusy(false);
		}
	};

	const loadTelemetry = async (app: EnvironmentApp) => {
		setBusy(true);
		setError(undefined);
		try {
			setTelemetry(await client.telemetry(app.id));
			setTraceId(undefined);
			setTraceIndex(0);
			setView("telemetry");
		} catch (reason) {
			const code = errorMessage(reason);
			const text =
				code === "operation-unavailable"
					? `No telemetry captured for ${app.id}.`
					: code;
			setError(text);
			setMessage(text);
		} finally {
			setBusy(false);
		}
	};

	const openTrace = async (id: string) => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			setTelemetry(await client.telemetry(app.id, id));
			setTraceId(id);
			setView("telemetry");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const openOperation = (
		next: OperationSummary,
		origin: "detail" | "history",
	) => {
		stopPolling();
		clearMessage();
		setProgress("");
		setOperationOrigin(origin);
		setOperation(next);
		setReceipt(null);
		setView("operation");
		if (next.hasResult || next.state === "issued") {
			void (async () => {
				try {
					const detail = await client.operation(next.id);
					setOperation(detail);
					if (detail.state === "issued") pollOperation(next.id);
				} catch (reason) {
					fail(reason);
				}
			})();
		}
	};

	const openSelected = () => {
		if (view() === "table") {
			const app = filteredApps()[selectedIndex()];
			if (app) openApp(app);
			return;
		}
		if (view() === "targets") {
			const target = selectedTarget();
			if (target) void executeTarget(targetAction(), target);
			return;
		}
		if (view() === "history") {
			const next = selectedOperation();
			if (next) openOperation(next, "history");
			return;
		}
		if (view() === "telemetry") {
			const trace = selectedTrace();
			if (trace) void openTrace(trace.traceId);
		}
	};

	const back = () => {
		if (view() === "table") return false;
		if (view() === "detail") {
			setView("table");
			return true;
		}
		if (view() === "targets" || view() === "logs" || view() === "telemetry") {
			setView("detail");
			return true;
		}
		if (view() === "changes") {
			setView("detail");
			return true;
		}
		if (view() === "diff") {
			setView("changes");
			return true;
		}
		if (view() === "operation") {
			stopPolling();
			setView(operationOrigin() === "history" ? "history" : "detail");
			return true;
		}
		if (view() === "history" || view() === "services") {
			setTab("applications");
			setView("table");
			return true;
		}
		return false;
	};

	const refresh = async () => {
		if (view() === "changes") {
			await refreshChanges();
			return;
		}
		if (view() === "diff") {
			await reloadDiff();
			return;
		}
		if (view() === "logs") {
			const app = selectedApp();
			if (app) await loadLogs(app);
			return;
		}
		if (view() === "telemetry") {
			const app = selectedApp();
			if (app) await loadTelemetry(app);
			return;
		}
		if (view() === "operation") {
			await refreshOperation();
			return;
		}
		await load();
	};

	const subjectFor = (next: OperationSummary | undefined) =>
		next?.subject ?? (next ? subjects.get(next.id) : undefined);
	const operationSubject = () => subjectFor(operation());

	return {
		apps,
		services,
		repositories,
		status,
		git,
		changes,
		changeIndex,
		diff,
		selectedChange,
		activeApps,
		operations,
		operationTotal,
		operation,
		progress,
		receipt,
		logs,
		telemetry,
		traceId,
		tab,
		view,
		selectedIndex,
		selectedAppId,
		targetAction,
		targetIndex,
		historyIndex,
		traceIndex,
		query,
		searchFocused,
		message,
		error,
		busy,
		counts,
		tabApps,
		filteredApps,
		selectedApp,
		targetList,
		selectedTarget,
		owned,
		selectedOwned,
		selectedOperation,
		selectedTrace,
		scope,
		appTotal,
		load,
		startLiveRefresh,
		stopLiveRefresh,
		handleEvent,
		loadStatus,
		loadHistory,
		selectTab,
		cycleTab,
		move,
		openApp,
		loadChanges,
		refreshChanges,
		openSelectedChange,
		reloadDiff,
		moveChange,
		setChangeIndex,
		openTargets,
		executeTarget,
		refreshOperation,
		stop,
		loadLogs,
		loadTelemetry,
		openTrace,
		openOperation,
		openSelected,
		back,
		refresh,
		subjectFor,
		operationSubject,
		setSelectedIndex,
		setSelectedAppId,
		setHistoryIndex,
		setTargetIndex,
		setTraceIndex,
		setQuery,
		setSearchFocused,
		setMessage,
		setError,
		setView,
		defaultTarget,
		shortId,
	};
}

export type EnvironmentStore = ReturnType<typeof createEnvironmentStore>;
