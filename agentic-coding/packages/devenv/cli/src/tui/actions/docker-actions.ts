import type { DevEnvClient } from "@devenv/core";
import type {
	ActionDefinition,
	ActionTarget,
	App,
	AppAction,
	InfraService,
} from "@devenv/types";
import type { AppStore } from "../stores/app-store";
import type { UiStore } from "../stores/ui-store";

export function operationProgressLabel(
	action: AppAction | "start" | "stop" | "restart",
): string {
	switch (action) {
		case "start":
			return "Starting";
		case "stop":
			return "Stopping";
		case "restart":
			return "Restarting";
		case "build":
			return "Building";
		case "test":
			return "Testing";
		case "run":
			return "Running";
	}
}

export function createDockerActions(
	appStore: AppStore,
	uiStore: UiStore,
	client: DevEnvClient,
	showError: (title: string, message: string) => void,
	_showActionLog?: (appIdent: string, appName: string) => Promise<void>,
) {
	const cancelAction = async (appIdent: string) => {
		try {
			await client.cancelAction(appIdent);
		} catch (e) {
			showError(
				"Cancel Action Failed",
				e instanceof Error ? e.message : String(e),
			);
		}
	};

	const getSelectedApp = (): App | InfraService | undefined =>
		appStore.filteredApps()[appStore.selectedIndex()] as
			| App
			| InfraService
			| undefined;

	const performDockerOperation = async (
		action: "start" | "stop" | "restart",
		app: App | InfraService,
		profile?: string,
		targetId?: string,
		runner?: "shell" | "powershell",
	) => {
		const appIdent = app.ident;
		appStore.setOperationInProgressForApp(appIdent);
		appStore.setError(null);
		appStore.setApps(
			appStore.apps().map((a) =>
				a.ident === appIdent
					? {
							...a,
							operationStatus: {
								operation: action as "start" | "stop",
								status: "active",
								message: `${operationProgressLabel(action)}...`,
							},
						}
					: a,
			),
		);
		appStore.setInfraServices((prev) =>
			prev.map((svc) =>
				svc.ident === appIdent
					? {
							...svc,
							operationStatus: {
								operation: action as "start" | "stop",
								status: "active",
								message: `${operationProgressLabel(action)}...`,
							},
						}
					: svc,
			),
		);

		try {
			if ("type" in app && (action === "start" || action === "stop")) {
				const definitions = (
					await client.getActionDefinitions(appIdent, "infrastructure")
				).actions.filter(
					(definition) =>
						definition.type === action && definition.availability.available,
				);
				const selected =
					definitions.find(
						(definition) => runner && definition.runtime === runner,
					) ?? definitions[0];
				if (!selected)
					throw new Error(`No available ${action} action configured`);
				appStore.pushModal("actions");
				await client.startActionRun(selected.id);
			} else if (action === "start") {
				{
					const definitions = (
						await client.getActionDefinitions(appIdent)
					).actions.filter(
						(definition) =>
							definition.type === "run" && definition.availability.available,
					);
					const selected = definitions.find(
						(definition) =>
							definition.id === targetId ||
							definition.id.endsWith(`/${profile || "default"}`),
					);
					if (selected) {
						appStore.pushModal("actions");
						await client.startActionRun(selected.id);
					} else if (definitions.length === 1) {
						appStore.pushModal("actions");
						await client.startActionRun(definitions[0].id);
					} else if (definitions.length > 1) {
						openActionTargetPicker(
							app as App,
							"run",
							definitions.map(definitionTarget),
						);
					} else throw new Error("No available run action configured");
				}
			} else if (action === "stop") {
				if ("type" in app) {
					const containerID =
						app.dockerInfo?.ContainerID || app.containerBaseName;
					if (!containerID)
						throw new Error(
							"No container identifier available for stop operation",
						);
					await client.stopContainer(containerID, appIdent);
				} else {
					const definitions = (
						await client.getActionDefinitions(appIdent)
					).actions.filter(
						(definition) =>
							definition.type === "stop" && definition.availability.available,
					);
					const targetInfo =
						"runTargetInfo" in app ? app.runTargetInfo : undefined;
					const activeProfile = targetInfo?.profile;
					const kubernetesRunning = app.runtimeStatus
						? app.runtimeStatus.detail?.includes("pods") &&
							(app.runtimeStatus.state === "running" ||
								app.runtimeStatus.state === "starting")
						: /\b(?:running|starting)\b.*\bpods?\b/i.test(app.status || "");
					const activeRuntime = kubernetesRunning
						? "kubernetes"
						: targetInfo?.runtime;
					const byProfile = activeProfile
						? definitions.filter((definition) =>
								definition.id.endsWith(`/${activeProfile}`),
							)
						: definitions;
					const selected =
						byProfile.find(
							(definition) => definition.runtime === activeRuntime,
						) ??
						definitions.find(
							(definition) => definition.runtime === activeRuntime,
						) ??
						byProfile.find((definition) => definition.runtime === "docker") ??
						byProfile[0] ??
						definitions[0];
					if (!selected) throw new Error("No available stop action configured");
					appStore.pushModal("actions");
					await client.startActionRun(selected.id);
				}
			} else {
				if ("type" in app) {
					const containerID =
						app.dockerInfo?.ContainerID || app.containerBaseName;
					if (!containerID)
						throw new Error(
							"No container identifier available for restart operation",
						);
					await client.restartContainer(containerID, appIdent);
				} else {
					const definitions = (
						await client.getActionDefinitions(appIdent)
					).actions.filter(
						(d) => d.type === "restart" && d.availability.available,
					);
					// Prefer docker runtime when both are available.
					const selected =
						definitions.find((d) => d.runtime === "docker") ?? definitions[0];
					if (!selected)
						throw new Error("No available restart action configured");
					appStore.pushModal("actions");
					await client.startActionRun(selected.id);
				}
			}
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : "Unknown error";
			const appName =
				appStore.apps().find((a) => a.ident === appIdent)?.displayName ||
				"Unknown Item";
			showError(
				`Docker ${action.charAt(0).toUpperCase() + action.slice(1)} Failed`,
				`Failed to ${action} ${appName}.\n\nError: ${errorMsg}`,
			);
			appStore.setApps(
				appStore.apps().map((a) =>
					a.ident === appIdent
						? {
								...a,
								operationStatus: {
									operation: action as "start" | "stop",
									status: "failed",
									message: `${action.charAt(0).toUpperCase() + action.slice(1)} failed`,
								},
							}
						: a,
				),
			);
			appStore.setInfraServices((prev) =>
				prev.map((svc) =>
					svc.ident === appIdent
						? {
								...svc,
								operationStatus: {
									operation: action as "start" | "stop",
									status: "failed",
									message: `${action.charAt(0).toUpperCase() + action.slice(1)} failed`,
								},
							}
						: svc,
				),
			);
			setTimeout(() => {
				appStore.setApps(
					appStore
						.apps()
						.map((a) =>
							a.ident === appIdent ? { ...a, operationStatus: undefined } : a,
						),
				);
				appStore.setInfraServices((prev) =>
					prev.map((svc) =>
						svc.ident === appIdent
							? { ...svc, operationStatus: undefined }
							: svc,
					),
				);
			}, 3000);
		} finally {
			appStore.setOperationInProgressForApp(null);
		}
	};

	const requestDockerOperation = async (
		action: "start" | "stop" | "restart",
	) => {
		const app = getSelectedApp();
		if (!app) {
			showError(
				"No Item Selected",
				"Please select an item before performing this operation.",
			);
			return;
		}
		if (appStore.operationInProgressForApp()) {
			const activeIdent = appStore.operationInProgressForApp();
			if (!activeIdent) return;
			const _active =
				appStore.apps().find((a) => a.ident === activeIdent) ||
				appStore.infraServices().find((svc) => svc.ident === activeIdent) ||
				app;
			appStore.pushModal("actions");
			return;
		}
		void performDockerOperation(action, app);
	};

	const setActionStatus = (
		appIdent: string,
		action: AppAction,
		message: string,
	) => {
		appStore.setApps(
			appStore.apps().map((a) =>
				a.ident === appIdent
					? {
							...a,
							operationStatus: {
								operation: action,
								status: "active",
								message,
							},
						}
					: a,
			),
		);
	};

	const createShellTarget = async (app: App, action: AppAction) => {
		const profile = action === "run" ? "dev" : undefined;
		const runtime = process.platform === "win32" ? "powershell" : "shell";
		try {
			const result = await client.createShellActionScript({
				ident: app.ident,
				action,
				profile,
				runtime,
			});
			showError(
				"Shell Target Created",
				`Created ${action} ${runtime} target for ${app.displayName}:\n${result.path}\n\nEdit this file in your config repository, then run the action again.`,
			);
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : "Unknown error";
			showError(
				"Create Shell Target Failed",
				`Failed to create shell ${action} target for ${app.displayName}.\n\nError: ${errorMsg}`,
			);
		}
	};

	const showNoTargets = (action: AppAction, app: App) => {
		const ext = process.platform === "win32" ? ".ps1" : ".sh";
		const path =
			action === "run"
				? `apps/run/${app.ident}-dev${ext}`
				: `apps/build/${app.ident}-${action}${ext}`;
		uiStore.setConfirmDialogTitle("No Target Configured");
		uiStore.setConfirmDialogMessage(
			`No ${action} target is configured for ${app.displayName}.\n\nCreate target script ${path}?`,
		);
		uiStore.setConfirmDialogAction(() => () => {
			void createShellTarget(app, action);
		});
		uiStore.setShowConfirmDialog(true);
	};

	const definitionTarget = (definition: ActionDefinition): ActionTarget => ({
		id: definition.id,
		action:
			definition.type === "start" ? "run" : (definition.type as AppAction),
		runtime: definition.runtime as ActionTarget["runtime"],
		label: definition.label,
		profile:
			typeof definition.root.configuration?.profile === "string"
				? definition.root.configuration.profile
				: undefined,
		sourcePath: "",
	});

	const openInfrastructureStartTargetPicker = async (infra: InfraService) => {
		try {
			const { actions } = await client.getActionDefinitions(
				infra.ident,
				"infrastructure",
			);
			const targets = actions
				.filter(
					(definition) =>
						definition.type === "start" && definition.availability.available,
				)
				.map(definitionTarget);
			if (targets.length === 0) {
				showError(
					"No Target Configured",
					`No available start action is configured for ${infra.displayName}.`,
				);
				return;
			}
			if (targets.length === 1) {
				appStore.pushModal("actions");
				await client.startActionRun(targets[0].id);
				return;
			}
			uiStore.setActionTargetPickerTargets(targets);
			uiStore.setActionTargetPickerSelectedIndex(0);
			uiStore.setActionTargetPickerAppIdent(infra.ident);
			uiStore.setActionTargetPickerAction("run");
			uiStore.setShowActionTargetPicker(true);
		} catch (error) {
			showError(
				"Target Discovery Failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	const runSelectedInfrastructureTarget = async (
		_infra: InfraService,
		target: ActionTarget,
	) => {
		try {
			appStore.pushModal("actions");
			await client.startActionRun(target.id);
		} catch (error) {
			showError(
				"Start Failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	const runSelectedTarget = async (
		app: App,
		action: AppAction,
		target: ActionTarget,
	) => {
		const appIdent = app.ident;
		appStore.setOperationInProgressForApp(appIdent);
		appStore.setError(null);
		setActionStatus(
			appIdent,
			action,
			`${operationProgressLabel(action)} ${target.label}...`,
		);
		try {
			appStore.pushModal("actions");
			await client.startActionRun(target.id);
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : "Unknown error";
			showError(
				`${action.charAt(0).toUpperCase() + action.slice(1)} Failed`,
				`Failed to ${action} ${app.displayName}.\n\nError: ${errorMsg}`,
			);
			appStore.setApps(
				appStore.apps().map((a) =>
					a.ident === appIdent
						? {
								...a,
								operationStatus: {
									operation: action,
									status: "failed",
									message: `${action} failed`,
								},
							}
						: a,
				),
			);
			setTimeout(() => {
				appStore.setApps(
					appStore
						.apps()
						.map((a) =>
							a.ident === appIdent ? { ...a, operationStatus: undefined } : a,
						),
				);
			}, 3000);
		} finally {
			appStore.setOperationInProgressForApp(null);
		}
	};

	const openActionTargetPicker = (
		app: App,
		action: AppAction,
		targets: ActionTarget[],
	) => {
		uiStore.setActionTargetPickerTargets(targets);
		uiStore.setActionTargetPickerSelectedIndex(0);
		uiStore.setActionTargetPickerAppIdent(app.ident);
		uiStore.setActionTargetPickerAction(action);
		uiStore.setShowActionTargetPicker(true);
	};

	const performAppAction = async (action: AppAction) => {
		const row = appStore.tableFilteredApps()[appStore.selectedIndex()];
		if (row?.rowKind !== "app") return;
		const app = row;

		const currentApp =
			appStore.apps().find((a) => a.ident === app.ident) ?? app;
		if (currentApp.operationStatus?.status === "active") {
			appStore.pushModal("actions");
			return;
		}
		if (appStore.operationInProgressForApp()) {
			const activeIdent = appStore.operationInProgressForApp();
			if (!activeIdent) return;
			const _active =
				appStore.apps().find((a) => a.ident === activeIdent) ||
				appStore.infraServices().find((svc) => svc.ident === activeIdent) ||
				app;
			appStore.pushModal("actions");
			return;
		}

		uiStore.setActionTargetPickerLoading(true);
		try {
			const result = await client.getActionDefinitions(app.ident);
			const definitions = result.actions.filter(
				(definition) => definition.type === action,
			);
			const targets = definitions
				.filter((definition) => definition.availability.available)
				.map(definitionTarget);
			if (targets.length === 0) {
				showNoTargets(action, app);
				return;
			}
			if (targets.length === 1) {
				await runSelectedTarget(app, action, targets[0]);
				return;
			}
			openActionTargetPicker(app, action, targets);
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : "Unknown error";
			showError(
				"Action Discovery Failed",
				`Failed to load ${action} actions for ${app.displayName}.\n\nError: ${errorMsg}`,
			);
		} finally {
			uiStore.setActionTargetPickerLoading(false);
		}
	};

	const performBuild = async () => {
		await performAppAction("build");
	};

	const refreshKubernetesCluster = async () => {
		appStore.setKubernetesClusterLoading(true);
		appStore.setKubernetesClusterError(null);
		try {
			const status = await client.getKubernetesClusterStatus();
			appStore.setKubernetesClusterStatus(status);
			if (!status.exists) {
				appStore.setKubernetesCPUHistory([]);
				appStore.setKubernetesMemoryHistory([]);
			} else if (status.stats) {
				const stats = status.stats;
				appStore.setKubernetesCPUHistory((history) => [
					...history.slice(-29),
					stats.cpuPercent,
				]);
				appStore.setKubernetesMemoryHistory((history) => [
					...history.slice(-29),
					stats.memoryPercent,
				]);
			}
		} catch (e) {
			appStore.setKubernetesClusterError(
				e instanceof Error ? e.message : "Unknown error",
			);
		} finally {
			appStore.setKubernetesClusterLoading(false);
		}
	};

	const runKubernetesClusterAction = async (type: string) => {
		const definitions = (
			await client.getActionDefinitions("local", "kubernetes")
		).actions.filter(
			(action) => action.type === type && action.availability.available,
		);
		let provider = appStore.kubernetesClusterStatus()?.provider;
		if (!provider) {
			try {
				provider = (await client.getKubernetesClusterStatus()).provider;
			} catch {
				/* fall back to first available provider */
			}
		}
		const definition =
			definitions.find((action) => action.runtime === provider) ??
			definitions[0];
		if (!definition) throw new Error(`No available Kubernetes ${type} action`);
		appStore.pushModal("actions");
		await client.startActionRun(definition.id);
	};

	const createCluster = async () => {
		uiStore.setLoadingModalMessage("Creating Kubernetes cluster...");
		uiStore.setShowLoadingModal(true);
		try {
			await runKubernetesClusterAction("create");
			await refreshKubernetesCluster();
		} catch (e) {
			showError(
				"Kubernetes Create Failed",
				e instanceof Error ? e.message : "Unknown error",
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const exportKubeconfig = async () => {
		try {
			await runKubernetesClusterAction("export-kubeconfig");
			uiStore.setNotification("Kubeconfig exported for kind-devenv", "info");
		} catch (e) {
			showError(
				"Kubeconfig Export Failed",
				e instanceof Error ? e.message : "Unknown error",
			);
		}
	};

	const requestDeleteCluster = () => {
		uiStore.setConfirmDialogTitle("Delete Kubernetes Cluster");
		uiStore.setConfirmDialogMessage(
			"Delete managed kind cluster kind-devenv?\n\nThis removes all in-cluster resources, namespaces, workloads, and DevEnv releases.",
		);
		uiStore.setConfirmDialogAction(() => async () => {
			uiStore.setLoadingModalMessage("Deleting Kubernetes cluster...");
			uiStore.setShowLoadingModal(true);
			try {
				await runKubernetesClusterAction("delete");
				appStore.setKubernetesCPUHistory([]);
				appStore.setKubernetesMemoryHistory([]);
				await refreshKubernetesCluster();
			} catch (e) {
				showError(
					"Kubernetes Delete Failed",
					e instanceof Error ? e.message : "Unknown error",
				);
			} finally {
				uiStore.setShowLoadingModal(false);
			}
		});
		uiStore.setShowConfirmDialog(true);
	};

	const requestRecreateCluster = () => {
		uiStore.setConfirmDialogTitle("Recreate Kubernetes Cluster");
		uiStore.setConfirmDialogMessage(
			"Recreate managed kind cluster kind-devenv?\n\nThis deletes the existing cluster and removes all in-cluster resources before creating a fresh cluster.",
		);
		uiStore.setConfirmDialogAction(() => async () => {
			uiStore.setLoadingModalMessage("Recreating Kubernetes cluster...");
			uiStore.setShowLoadingModal(true);
			try {
				await runKubernetesClusterAction("recreate");
				appStore.setKubernetesCPUHistory([]);
				appStore.setKubernetesMemoryHistory([]);
				await refreshKubernetesCluster();
			} catch (e) {
				showError(
					"Kubernetes Recreate Failed",
					e instanceof Error ? e.message : "Unknown error",
				);
			} finally {
				uiStore.setShowLoadingModal(false);
			}
		});
		uiStore.setShowConfirmDialog(true);
	};

	const performTest = async () => {
		await performAppAction("test");
	};

	return {
		cancelAction,
		requestDockerOperation,
		performDockerOperation,
		openInfrastructureStartTargetPicker,
		runSelectedInfrastructureTarget,
		performBuild,
		performTest,
		performAppAction,
		runSelectedTarget,
		refreshKubernetesCluster,
		createCluster,
		exportKubeconfig,
		requestDeleteCluster,
		requestRecreateCluster,
	};
}

export type DockerActions = ReturnType<typeof createDockerActions>;
