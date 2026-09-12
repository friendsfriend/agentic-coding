import { getLogger } from "@devenv/core";
import { detectOptionalUtilities } from "../startup-utility-detection";
import type { AppStore } from "../stores";
import type { AppActions } from "./app-actions";

async function waitForActionRegistry(
	client: ReturnType<typeof import("@devenv/core").createClient>,
	appStore: AppStore,
	showError: (title: string, message: string) => void,
): Promise<boolean> {
	let retries = 30;
	let delay = 500;
	while (retries > 0) {
		try {
			const status = await client.getActionRegistryStatus();
			if (status.available) {
				getLogger().write(
					"INFO",
					`Action registry ready: ${status.actionsCount} actions (version ${status.version})`,
				);
				return true;
			}
			if (status.error) {
				appStore.setStartupState({
					phase: "failed",
					message: "Action registry compilation failed",
					error: `Registry error: ${status.error}\n\nCheck server logs at $DEVENV_HOME/logs/server.log`,
				});
				showError("Registry Compilation Failed", status.error);
				return false;
			}
		} catch (_e) {
			// Server may not have the endpoint yet; retry
		}
		retries--;
		if (retries > 0) {
			appStore.setStartupState({
				phase: "loading-action-registry",
				message: `Waiting for action definitions... (${30 - retries}/30)`,
				error: null,
			});
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * 1.5, 2000);
		}
	}
	const msg =
		"Action registry did not become available after 30 retries. Check server logs.";
	appStore.setStartupState({
		phase: "failed",
		message: "Registry timeout",
		error: msg,
	});
	showError("Registry Timeout", msg);
	return false;
}

interface InitDeps {
	client: ReturnType<typeof import("@devenv/core").createClient>;
	appStore: AppStore;
	appActions: AppActions;
	showError: (title: string, message: string) => void;
	serverUrl: string;
	refreshProviders?: () => Promise<void>;
	abortSignal?: AbortSignal;
}

/**
 * Runs initialization logic on mount: health check with retries,
 * initial data fetch (apps, infra), and starts background subscriptions.
 */
export async function initializeApp(deps: InitDeps): Promise<void> {
	const {
		client,
		appStore,
		appActions,
		showError,
		serverUrl,
		refreshProviders,
	} = deps;

	getLogger().write("INFO", "====== TUI APP MOUNTED ======");
	getLogger().write("INFO", `Server URL: ${serverUrl}`);
	getLogger().write("INFO", `Client baseUrl: ${client.baseUrl}`);

	try {
		let healthy = false;
		let retries = 10;
		let delay = 100;

		appStore.setStartupState({
			phase: "connecting",
			message: "Connecting to DevEnv server...",
			error: null,
		});

		while (retries > 0 && !healthy) {
			const attempt = 11 - retries;
			appStore.setStartupState({
				phase: "connecting",
				message: `Connecting to DevEnv server... attempt ${attempt}/10`,
				error: null,
			});
			getLogger().write(
				"DEBUG",
				`Attempting health check to: ${client.baseUrl}/api/health`,
			);
			healthy = await client.health();
			if (!healthy) {
				getLogger().write(
					"DEBUG",
					`Health check failed, retries left: ${retries}, waiting ${delay}ms`,
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
				delay = Math.min(delay * 1.5, 2000);
				retries--;
			} else {
				getLogger().write("INFO", "Health check succeeded!");
			}
		}

		if (!healthy) {
			const message = `Cannot connect to DevEnv server at ${serverUrl}. The server may still be starting or may have failed to start.`;
			appStore.setStartupState({
				phase: "failed",
				message: "Connection failed",
				error: message,
			});
			appStore.setError(message);
			showError("Server Connection Failed", message);
			return;
		}

		getLogger().write("INFO", "Server health check passed!");
		appStore.setStartupState({
			phase: "server-ready",
			message: "DevEnv server is ready.",
			error: null,
		});

		// Wait for action registry to compile successfully
		appStore.setStartupState({
			phase: "loading-action-registry",
			message: "Waiting for action definitions...",
			error: null,
		});
		const actionRegistryOk = await waitForActionRegistry(
			client,
			appStore,
			showError,
		);
		if (!actionRegistryOk) return;

		const serverProcess = (
			globalThis as {
				__devenvServerProcess?: { killed: boolean; exitCode: number | null };
			}
		).__devenvServerProcess;
		if (serverProcess) {
			getLogger().write(
				"DEBUG",
				`[APP] Server process status before apps fetch - killed: ${serverProcess.killed}, exitCode: ${serverProcess.exitCode}`,
			);
		}

		getLogger().write("DEBUG", "Fetching apps...");
		appStore.setStartupState({
			phase: "loading-applications",
			message: "Loading applications...",
			error: null,
		});
		getLogger().write(
			"DEBUG",
			`About to call client.getApps() with baseUrl: ${client.baseUrl}`,
		);
		const fetchedApps = await client.getApps();
		getLogger().write("DEBUG", `Fetched ${fetchedApps.length} apps`);

		if (serverProcess) {
			getLogger().write(
				"DEBUG",
				`[APP] Server process status after apps fetch - killed: ${serverProcess.killed}, exitCode: ${serverProcess.exitCode}`,
			);
		}

		appStore.setApps(fetchedApps);
		appStore.setStartupState({
			phase: "loading-infrastructure",
			message: "Loading infrastructure services...",
			error: null,
		});
		getLogger().write("DEBUG", "Fetching infrastructure services...");
		const fetchedInfraServices = await client.getInfraServices();
		getLogger().write(
			"DEBUG",
			`Fetched ${fetchedInfraServices.length} infrastructure services`,
		);
		appStore.setInfraServices(fetchedInfraServices);
		appStore.setStartupState({
			phase: "loading-scripts",
			message: "Loading scripts...",
			error: null,
		});
		getLogger().write("DEBUG", "Fetching scripts...");
		await appActions.loadScripts();
		appStore.setStartupState({
			phase: "loading-providers",
			message: "Loading providers...",
			error: null,
		});
		getLogger().write("DEBUG", "Fetching providers...");
		await refreshProviders?.();

		getLogger().write("INFO", "Initial data fetch complete");
		appStore.setStartupState({
			phase: "complete",
			message: "Startup complete.",
			error: null,
		});
		appStore.setLoading(false);

		void appActions.fetchStatus();
		void appActions.subscribeToUpdates(deps.abortSignal);

		// Detect optional utilities in background (non-blocking)
		detectOptionalUtilities();
	} catch (e) {
		const errorMsg =
			e instanceof Error
				? e.message
				: "Unknown error occurred during initialization";
		getLogger().write("ERROR", `Initialization error: ${errorMsg}`);
		if (e instanceof Error && e.stack) {
			getLogger().write("ERROR", `Stack: ${e.stack}`);
		}
		appStore.setStartupState({
			phase: "failed",
			message: errorMsg,
			error: errorMsg,
		});
		showError("Initialization Failed", errorMsg);
		appStore.setLoading(false);
	}
}
