import type { DevEnvClient } from "@devenv/core";
import { getLogger } from "@devenv/core";
import type {
	ActionDefinition,
	ActionTarget,
	App,
	AppRunTargetInfo,
	DockerInfo,
	ExecutionHandle,
	OperationStatus,
	ResourceKind,
	RuntimeStatus,
} from "@devenv/types";
import {
	buildDependencyTree,
	type DependencyNode,
	runtimeState,
} from "@devenv/ui";
import { batch } from "solid-js";
import { exitApp } from "../exit";
import type { ActionRunStore } from "../stores/action-run-store";
import type { AppDetailStore } from "../stores/app-detail-store";
import type { AppStore } from "../stores/app-store";
import type { UiStore } from "../stores/ui-store";

function actionDefinitionTarget(definition: ActionDefinition): ActionTarget {
	const execute = definition.root.children?.[0];
	return {
		id: definition.id,
		action: definition.type as ActionTarget["action"],
		runtime: definition.runtime as ActionTarget["runtime"],
		label: definition.label,
		profile:
			typeof execute?.configuration?.profile === "string"
				? execute.configuration.profile
				: undefined,
		sourcePath: "",
		requires: Array.isArray(execute?.configuration?.requires)
			? (execute.configuration.requires as ActionTarget["requires"])
			: undefined,
	};
}

function normalizeNodeStatus(
	raw: string | undefined,
): "running" | "stopped" | "failed" | "unknown" {
	if (!raw) return "unknown";
	const lower = raw.toLowerCase();
	if (lower.includes("running") || lower.includes("healthy") || lower === "up")
		return "running";
	if (lower.includes("stopped") || lower.includes("exited") || lower === "down")
		return "stopped";
	if (
		lower.includes("failed") ||
		lower.includes("dead") ||
		lower.includes("error")
	)
		return "failed";
	return "unknown";
}

let appDetailAbortController: AbortController | null = null;

export function handleActionStarted(
	appStore: Pick<AppStore, "pushModal">,
	actionRunStore: ActionRunStore,
	properties: Record<string, unknown>,
) {
	actionRunStore.handleEvent("action.started", properties);
	actionRunStore.selectLastIfNone();
	appStore.pushModal("actions");
}

export function createAppActions(
	appStore: AppStore,
	appDetailStore: AppDetailStore,
	uiStore: UiStore,
	client: DevEnvClient,
	showError: (title: string, message: string) => void,
	actionRunStore?: ActionRunStore,
) {
	const getSelectedApp = () =>
		appStore.tableFilteredApps()[appStore.selectedIndex()];

	const fetchStatus = async () => {
		try {
			const statuses = await client.getStatus();
			appStore.setApps((prevApps) =>
				prevApps.map((app) => {
					const status = statuses.find((s) => s.ident === app.ident);
					if (!status) return app;
					const updated: typeof app = {
						...app,
						resourceId: status.resourceId ?? app.resourceId,
						resourceKind: status.resourceKind ?? app.resourceKind,
						dockerInfo: status.dockerInfo,
						branch: status.branch || app.branch,
						gitStatus: status.gitStatus,
						operationStatus: status.operationStatus,
						status: status.status ?? app.status,
					};
					if (status.runtimeStatus == null) delete updated.runtimeStatus;
					else updated.runtimeStatus = status.runtimeStatus;
					if (status.activeWorktree)
						updated.activeWorktree = status.activeWorktree;
					else delete updated.activeWorktree;
					if ("runTargetInfo" in status) {
						if (status.runTargetInfo == null) delete updated.runTargetInfo;
						else updated.runTargetInfo = status.runTargetInfo;
					}
					return updated;
				}),
			);
			if (typeof client.getInfraServices === "function") {
				const services = await client.getInfraServices();
				appStore.setInfraServices((previous) =>
					previous.map(
						(service) =>
							services.find((next) => next.ident === service.ident) ?? service,
					),
				);
			}
		} catch (e) {
			console.error("Failed to fetch status:", e);
		}
	};

	let actionHistoryHydrated = false;
	const subscribeToUpdates = async (signal?: AbortSignal) => {
		try {
			if (actionRunStore && !actionHistoryHydrated) {
				const replay = (
					history: Awaited<ReturnType<typeof client.getActionHistory>>,
				) =>
					batch(() => {
						for (const event of history) {
							try {
								if (event.type.startsWith("action."))
									actionRunStore.handleEvent(
										event.type,
										event.properties as Record<string, unknown>,
										"history",
									);
							} catch (inner) {
								getLogger().write(
									"ERROR",
									"Failed to replay action event: " +
										(inner instanceof Error ? inner.message : String(inner)),
								);
							}
						}
						actionRunStore.selectLastIfNone();
					});
				replay(await client.getActionHistory());
				actionRunStore.configureHistoryLoader(async () =>
					replay(await client.getActionHistory("older")),
				);
				actionRunStore.configureLogsLoader(async (runId, stepId) =>
					replay(await client.getActionLogs(runId, stepId)),
				);
				actionHistoryHydrated = true;
			}
			appStore.setLiveUpdatesActive(true);
			getLogger().write("INFO", "Starting SSE subscription...");
			for await (const event of client.subscribeToEvents(signal)) {
				if (event.type.startsWith("action.")) {
					try {
						if (event.type === "action.started") {
							if (actionRunStore)
								handleActionStarted(
									appStore,
									actionRunStore,
									event.properties as Record<string, unknown>,
								);
						} else {
							const actionProperties = event.properties as Record<
								string,
								unknown
							>;
							actionRunStore?.handleEvent(event.type, actionProperties);
							// Refresh runtime and infra snapshots before clearing transient UI state.
							// Infra actions do not use /api/status, so clear their optimistic overlay
							// explicitly after the infra snapshot request completes.
							if (event.type === "action.completed") {
								void fetchStatus().then(() => {
									if (
										actionProperties.resourceKind !== "infrastructure" ||
										typeof actionProperties.appIdent !== "string"
									)
										return;
									appStore.setInfraServices((previous) =>
										previous.map((service) => {
											if (service.ident !== actionProperties.appIdent)
												return service;
											const { operationStatus: _operationStatus, ...rest } =
												service;
											return rest;
										}),
									);
								});
							}
						}
					} catch (inner) {
						getLogger().write(
							"ERROR",
							"Failed to process action event: " +
								(inner instanceof Error ? inner.message : String(inner)),
						);
					}
					continue;
				}

				if (event.type === "connection.established") {
					appStore.setLiveUpdatesActive(true);
					continue;
				}

				if (event.type === "server.notification") {
					const props = event.properties as {
						message: string;
						type?: "info" | "success" | "warning" | "error";
					};
					uiStore.setNotification(props.message, props.type ?? "warning");
					continue;
				}

				if (event.type === "status.updated") {
					const props = event.properties as {
						ident: string;
						resourceId?: string;
						resourceKind?: ResourceKind;
						dockerInfo?: DockerInfo | null;
						runtimeStatus?: RuntimeStatus | null;
						branch?: string;
						gitStatus?: string;
						operationStatus?: OperationStatus | null;
						activeWorktree?: string | null;
						status?: string;
						logPath?: string;
						runTargetInfo?: AppRunTargetInfo | null;
						executionHandle?: ExecutionHandle | null;
					};
					const {
						ident,
						resourceId,
						resourceKind,
						dockerInfo,
						runtimeStatus,
						branch,
						gitStatus,
						operationStatus,
						activeWorktree,
						status,
						logPath,
						runTargetInfo,
					} = props;
					const targetsApps = resourceKind !== "infrastructure";
					const targetsInfra =
						resourceKind === "infrastructure" || resourceKind === undefined;
					appStore.setLastUpdateTime(new Date());
					if (targetsApps)
						appStore.setApps((prevApps) =>
							prevApps.map((app) => {
								if (app.ident !== ident) return app;
								const updated: typeof app = {
									...app,
									resourceId: resourceId ?? app.resourceId,
									resourceKind: resourceKind ?? app.resourceKind,
									branch: branch || app.branch,
								};
								if ("dockerInfo" in props) {
									if (dockerInfo == null) delete updated.dockerInfo;
									else updated.dockerInfo = dockerInfo;
								}
								if ("runtimeStatus" in props) {
									if (runtimeStatus == null) delete updated.runtimeStatus;
									else updated.runtimeStatus = runtimeStatus;
								}
								if ("status" in props) updated.status = status;
								if ("gitStatus" in props) updated.gitStatus = gitStatus;
								if ("activeWorktree" in props) {
									if (activeWorktree == null) delete updated.activeWorktree;
									else updated.activeWorktree = activeWorktree;
								}
								if ("operationStatus" in props) {
									if (operationStatus == null) delete updated.operationStatus;
									else updated.operationStatus = operationStatus;
								}
								if ("runTargetInfo" in props) {
									if (runTargetInfo == null) delete updated.runTargetInfo;
									else updated.runTargetInfo = runTargetInfo;
								}
								return updated;
							}),
						);
					if (targetsInfra)
						appStore.setInfraServices((prev) =>
							prev.map((svc) => {
								if (svc.ident !== ident) return svc;
								const { executionHandle } = props;
								const updated: typeof svc = {
									...svc,
									resourceId: resourceId ?? svc.resourceId,
									resourceKind: resourceKind ?? svc.resourceKind,
								};
								if ("dockerInfo" in props) {
									if (dockerInfo == null) delete updated.dockerInfo;
									else updated.dockerInfo = dockerInfo;
								}
								if ("runtimeStatus" in props) {
									if (runtimeStatus == null) delete updated.runtimeStatus;
									else updated.runtimeStatus = runtimeStatus;
								}
								if ("status" in props) updated.status = status;
								if ("logPath" in props) updated.logPath = logPath;
								if ("executionHandle" in props) {
									if (executionHandle == null) delete updated.executionHandle;
									else updated.executionHandle = executionHandle;
								}
								if ("operationStatus" in props) {
									if (operationStatus == null) delete updated.operationStatus;
									else updated.operationStatus = operationStatus;
								}
								return updated;
							}),
						);
				}

				if (event.type === "operation.status.changed") {
					const { appIdent, operation, status, message } =
						event.properties as unknown as OperationStatus & {
							appIdent: string;
						};
					const nextOperationStatus = { operation, status, message };
					appStore.setApps((prevApps) =>
						prevApps.map((app) =>
							app.ident === appIdent
								? { ...app, operationStatus: nextOperationStatus }
								: app,
						),
					);
					appStore.setInfraServices((prev) =>
						prev.map((svc) =>
							svc.ident === appIdent
								? { ...svc, operationStatus: nextOperationStatus }
								: svc,
						),
					);
				}

				if (event.type === "operation.status.cleared") {
					const { appIdent } = event.properties as { appIdent: string };
					appStore.setApps((prevApps) =>
						prevApps.map((app) => {
							if (app.ident !== appIdent) return app;
							const { operationStatus: _op, ...rest } = app;
							return rest;
						}),
					);
					appStore.setInfraServices((prev) =>
						prev.map((svc) => {
							if (svc.ident !== appIdent) return svc;
							const { operationStatus: _op, ...rest } = svc;
							return rest;
						}),
					);
				}

				if (event.type === "kubernetes.cluster.refreshed") {
					const cStatus =
						event.properties as unknown as import("@devenv/types").KubernetesClusterStatus;
					if (cStatus?.clusterName) {
						appStore.setKubernetesClusterStatus(cStatus);
						appStore.setKubernetesClusterError(null);
						if (cStatus.stats) {
							const stats = cStatus.stats;
							appStore.setKubernetesCPUHistory((h) => [
								...h.slice(-29),
								stats.cpuPercent,
							]);
							appStore.setKubernetesMemoryHistory((h) => [
								...h.slice(-29),
								stats.memoryPercent,
							]);
						}
					}
					continue;
				}

				if (event.type === "kubernetes.cluster.deleted") {
					appStore.setKubernetesCPUHistory([]);
					appStore.setKubernetesMemoryHistory([]);
				}
			}
		} catch (e) {
			appStore.setLiveUpdatesActive(false);
			getLogger().write(
				"ERROR",
				`SSE error: ${e instanceof Error ? e.message : String(e)}`,
			);
			console.error("SSE error:", e);
		}
	};

	const normalizeScriptRelativePath = (value: string) =>
		value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");

	const parentScriptPath = (value: string) => {
		const normalized = normalizeScriptRelativePath(value);
		if (!normalized) return "";
		const parts = normalized.split("/");
		if (parts.length <= 1) return "";
		parts.pop();
		return parts.join("/");
	};

	const loadScripts = async (focusRelativePath?: string) => {
		const data = await client.getScripts();
		appStore.setScriptsTree(data.scripts || []);
		appStore.setAllScriptFoldersExpanded();

		if (!focusRelativePath) return;
		const normalizedFocus = normalizeScriptRelativePath(focusRelativePath);
		const rows = appStore.tableFilteredApps();
		let targetPath = normalizedFocus;
		let idx = rows.findIndex((row) => row.scriptRelativePath === targetPath);
		while (idx < 0 && targetPath.includes("/")) {
			targetPath = parentScriptPath(targetPath);
			idx = rows.findIndex((row) => row.scriptRelativePath === targetPath);
		}
		if (idx >= 0) appStore.setSelectedIndex(idx);
	};

	const openAddTaskModal = () => {
		if (appStore.activeTab() !== "scripts") return;

		const selected = appStore.tableFilteredApps()[appStore.selectedIndex()];
		let prefill = "";
		if (selected?.resourceType === "script-folder") {
			prefill = normalizeScriptRelativePath(selected.scriptRelativePath || "");
		} else if (selected?.resourceType === "script-file") {
			prefill = parentScriptPath(selected.scriptRelativePath || "");
		}

		uiStore.setTaskAddMode("create");
		uiStore.setTaskAddTargetPath(prefill);
		uiStore.setTaskAddSourcePath("");
		uiStore.setTaskAddSelectedField(1);
		uiStore.setTaskAddError(null);
		uiStore.setShowTaskAddModal(true);
	};

	const closeAddTaskModal = () => {
		uiStore.setShowTaskAddModal(false);
		uiStore.setTaskAddError(null);
		uiStore.setTaskAddSelectedField(0);
	};

	const submitAddTask = async () => {
		const targetPath = uiStore.taskAddTargetPath().trim();
		const mode = uiStore.taskAddMode();

		if (!targetPath) {
			uiStore.setTaskAddError("Target name/path is required.");
			return;
		}

		if (mode === "link" && !uiStore.taskAddSourcePath().trim()) {
			uiStore.setTaskAddError(
				'Source task file path is required for "Use existing task file".',
			);
			return;
		}

		try {
			const result =
				mode === "create"
					? await client.createScript(targetPath)
					: await client.linkScript(
							targetPath,
							uiStore.taskAddSourcePath().trim(),
						);

			closeAddTaskModal();
			await loadScripts(result.relativePath);
			getLogger().write(
				"INFO",
				`Task ${result.operation} succeeded: ${result.relativePath}`,
			);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			uiStore.setTaskAddError(message);
			getLogger().write("WARN", `Task add failed: ${message}`);
		}
	};

	const toggleScriptFolder = () => {
		const row = appStore.tableFilteredApps()[appStore.selectedIndex()];
		if (row?.resourceType !== "script-folder" || !row.scriptRelativePath)
			return;

		appStore.setExpandedScriptFolders((prev) => {
			const scriptRelativePath = row.scriptRelativePath;
			if (!scriptRelativePath) return prev;
			const next = new Set(prev);
			if (next.has(scriptRelativePath)) next.delete(scriptRelativePath);
			else next.add(scriptRelativePath);
			return next;
		});
	};

	// executeSelectedScript was removed — the foreground path (runSelectedScriptInForeground)
	// is the canonical interactive path. Use utilActions.runSelectedScriptInForeground() instead.

	const openAppDetail = async () => {
		const app = getSelectedApp();
		if (!app) return;
		const kind =
			appStore.activeTab() === "infrastructure"
				? "infra"
				: app.appType === "LIB"
					? "library"
					: "app";
		appDetailStore.setAppDetailKind(kind);
		appDetailStore.setAppDetailApp(app as App);
		appDetailStore.setAppDetailLoading(true);
		appDetailStore.setAppDetailGitInfo(undefined);
		appDetailStore.setAppDetailCRs([]);
		appDetailStore.setAppDetailCRsLoading(kind !== "infra");
		appDetailStore.setAppDetailLogs("");
		appDetailStore.setAppDetailStatsHistory([]);
		appDetailStore.setAppDetailMemHistory([]);
		appDetailStore.setAppDetailLatestStats(undefined);
		appDetailStore.setActionTargets([]);
		appDetailStore.setActionTargetsLoading(false);
		appDetailStore.setDependencyTreeFocused(false);
		appDetailStore.setDependencyTreeSelectedIndex(0);
		appDetailStore.setAppDetailPanelIndex(0);
		appStore.pushView("appDetail");

		if (kind !== "infra") {
			try {
				appDetailStore.setAppDetailGitInfo(await client.getGitInfo(app.ident));
			} catch {
				appDetailStore.setAppDetailGitInfo({
					branch: app.branch || "?",
					status: "unknown",
				});
			}

			try {
				const result = await client.getChangeRequests(
					app.ident,
					"opened",
					"current",
					app.sourceType,
				);
				if (result.items.length > 0)
					appDetailStore.setAppDetailCRs(result.items.slice(0, 5));
				else
					appDetailStore.setAppDetailCRs(
						(
							await client.getChangeRequests(
								app.ident,
								"opened",
								"all",
								app.sourceType,
							)
						).items.slice(0, 5),
					);
			} catch {
				try {
					appDetailStore.setAppDetailCRs(
						(
							await client.getChangeRequests(
								app.ident,
								"opened",
								"all",
								app.sourceType,
							)
						).items.slice(0, 5),
					);
				} catch {
					appDetailStore.setAppDetailCRs([]);
				}
			}
			appDetailStore.setAppDetailCRsLoading(false);
		}

		// Fetch action targets for dependency tree
		if (kind !== "infra" && kind !== "library") {
			appDetailStore.setActionTargetsLoading(true);
			try {
				let targets = (await client.getActionDefinitions(app.ident)).actions
					.filter((definition) => definition.type === "run")
					.map(actionDefinitionTarget);
				// Filter to only the active run target's dependencies
				const runInfo = "runTargetInfo" in app ? app.runTargetInfo : undefined;
				if (runInfo) {
					const activeTarget = targets.find(
						(t) =>
							(runInfo.targetId && t.id === runInfo.targetId) ||
							(runInfo.profile && t.profile === runInfo.profile) ||
							(!runInfo.profile && !t.profile),
					);
					targets = activeTarget ? [activeTarget] : targets;
				}
				appDetailStore.setActionTargets(targets);
				// Build initial dependency tree
				const allApps = appStore.apps();
				const allInfra = appStore.infraServices();
				const appStatusMap = new Map(
					allApps.map((a) => [
						a.ident,
						runtimeState(a.runtimeStatus, a.status || a.dockerInfo?.Status),
					]),
				);
				const infraStatusMap = new Map(
					allInfra.map((s) => [
						s.ident,
						runtimeState(s.runtimeStatus, s.status || s.dockerInfo?.Status),
					]),
				);
				appDetailStore.setDependencyTreeNodes(
					buildDependencyTree(targets, appStatusMap, infraStatusMap),
				);
				// Keep dependency tree selection ready, but do not steal initial panel focus.
				if (targets.length > 0) {
					appDetailStore.setDependencyTreeSelectedIndex(0);
				}
			} catch {
				appDetailStore.setActionTargets([]);
			}
			appDetailStore.setActionTargetsLoading(false);
		}

		appDetailStore.setAppDetailLoading(false);
		const containerID = app.dockerInfo?.ContainerID;
		if (!containerID) return;

		appDetailAbortController = new AbortController();
		const signal = appDetailAbortController.signal;
		void client.streamContainerLogs(containerID, signal, (line) => {
			appDetailStore.setAppDetailLogs((prev) => {
				const updated = prev ? `${prev}\n${line}` : line;
				const lines = updated.split("\n");
				return lines.length > 500 ? lines.slice(-500).join("\n") : updated;
			});
		});
		void client.streamContainerStats(containerID, signal, (stats) => {
			appDetailStore.setAppDetailLatestStats(stats);
			appDetailStore.setAppDetailStatsHistory((prev) => {
				const next = [...prev, stats.cpuPercent];
				return next.length > 200 ? next.slice(-200) : next;
			});
			appDetailStore.setAppDetailMemHistory((prev) => {
				const next = [...prev, stats.memoryPercent];
				return next.length > 200 ? next.slice(-200) : next;
			});
		});
	};

	const closeAppDetail = () => {
		if (appDetailAbortController) {
			appDetailAbortController.abort();
			appDetailAbortController = null;
		}
		appStore.resetViewStack("table");
	};

	const performRemoveTaskTarget = async (relativePath: string) => {
		try {
			const result = await client.deleteScript(relativePath);
			await loadScripts(parentScriptPath(result.relativePath));
			getLogger().write("INFO", `Task target deleted: ${result.relativePath}`);
		} catch (e) {
			showError(
				"Delete Task Failed",
				e instanceof Error ? e.message : "Unknown error",
			);
		}
	};

	const requestRemoveTask = () => {
		if (appStore.activeTab() !== "scripts") return;
		const selected = appStore.tableFilteredApps()[appStore.selectedIndex()];
		if (!selected?.scriptRelativePath) return;

		if (selected.resourceType === "script-file") {
			uiStore.setConfirmDialogTitle("Delete Task");
			uiStore.setConfirmDialogMessage(
				`Delete task "${selected.displayName}" (${selected.scriptRelativePath})? This cannot be undone.`,
			);
		} else if (selected.resourceType === "script-folder") {
			uiStore.setConfirmDialogTitle("Delete Task Folder");
			uiStore.setConfirmDialogMessage(
				`Delete folder "${selected.displayName}" (${selected.scriptRelativePath}) and all nested task files? This cannot be undone.`,
			);
		} else {
			return;
		}

		uiStore.setConfirmDialogAction(
			() => () =>
				void performRemoveTaskTarget(selected.scriptRelativePath as string),
		);
		uiStore.setShowConfirmDialog(true);
	};

	const performRemoveApp = async (ident: string) => {
		try {
			await client.deleteApp(ident);
			appStore.setApps(await client.getApps());
		} catch (e) {
			showError(
				"Remove Repository Failed",
				e instanceof Error ? e.message : "Unknown error",
			);
		}
	};

	const requestRemoveApp = () => {
		const app = getSelectedApp();
		if (!app || appStore.activeTab() === "scripts") return;
		uiStore.setConfirmDialogTitle("Remove Selected Item");
		uiStore.setConfirmDialogMessage(
			`Remove "${app.displayName}" (${app.ident})? This will delete the local directory and remove it from the configuration.`,
		);
		uiStore.setConfirmDialogAction(
			() => () => void performRemoveApp(app.ident),
		);
		uiStore.setShowConfirmDialog(true);
	};

	const createExampleConfig = async () => {
		appStore.setExampleConfigLoading(true);
		appStore.setExampleConfigMessage("Creating example config...");
		try {
			await client.createExampleConfig();
			appStore.setApps(await client.getApps());
			appStore.setInfraServices(await client.getInfraServices());
			await loadScripts();
			appStore.setExampleConfigMessage("Example config created.");
		} catch (e) {
			appStore.setExampleConfigMessage(
				e instanceof Error ? e.message : "Failed to create example config",
			);
		} finally {
			appStore.setExampleConfigLoading(false);
		}
	};

	const expandDependencyNode = async (nodeKey: string) => {
		const nodes = appDetailStore.dependencyTreeNodes();
		const found = nodes.find((n) => n.key === nodeKey);
		if (found?.kind !== "app" || found.deduped) return;

		if (found.expanded) {
			found.expanded = false;
			found.children = [];
			found.childrenLoaded = false;
			appDetailStore.setDependencyTreeNodes([...nodes]);
			return;
		}

		if (found.childrenLoaded) return;

		found.loading = true;
		appDetailStore.setDependencyTreeNodes([...nodes]);

		const allApps = appStore.apps();
		const allInfra = appStore.infraServices();
		const appStatusMap = new Map(
			allApps.map((a) => [
				a.ident,
				runtimeState(a.runtimeStatus, a.status || a.dockerInfo?.Status),
			]),
		);
		const infraStatusMap = new Map(
			allInfra.map((s) => [
				s.ident,
				runtimeState(s.runtimeStatus, s.status || s.dockerInfo?.Status),
			]),
		);

		try {
			const childTargets = (
				await client.getActionDefinitions(found.name)
			).actions
				.filter((definition) => definition.type === "run")
				.map(actionDefinitionTarget);
			const requires = childTargets.flatMap((t) => t.requires ?? []);
			const children: DependencyNode[] = [];
			for (const ref of requires) {
				if (ref.app) {
					const key = `app:${ref.app}`;
					children.push({
						key,
						name: ref.app,
						kind: "app",
						runtime: ref.runtime,
						profile: ref.profile,
						status: normalizeNodeStatus(appStatusMap.get(ref.app)),
						expanded: false,
						childrenLoaded: false,
						loading: false,
						children: [],
						depth: found.depth + 1,
						deduped: false,
						cycled: false,
					});
				} else if (ref.infra) {
					const key = `infra:${ref.infra}`;
					children.push({
						key,
						name: ref.infra,
						kind: "infra",
						status: normalizeNodeStatus(infraStatusMap.get(ref.infra)),
						expanded: false,
						childrenLoaded: false,
						loading: false,
						children: [],
						depth: found.depth + 1,
						deduped: false,
						cycled: false,
					});
				}
			}
			found.expanded = true;
			found.childrenLoaded = true;
			found.loading = false;
			found.children = children;
		} catch {
			found.loading = false;
			found.childrenLoaded = true;
		}
		appDetailStore.setDependencyTreeNodes([...nodes]);
	};

	return {
		fetchStatus,
		subscribeToUpdates,
		loadScripts,
		openAddTaskModal,
		closeAddTaskModal,
		submitAddTask,
		toggleScriptFolder,
		openAppDetail,
		closeAppDetail,
		exitApp,
		requestRemoveTask,
		performRemoveTaskTarget,
		requestRemoveApp,
		performRemoveApp,
		createExampleConfig,
		expandDependencyNode,
	};
}

export type AppActions = ReturnType<typeof createAppActions>;
