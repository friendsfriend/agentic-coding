import type { DevEnvClient } from "@devenv/core";
import { getLogger } from "@devenv/core";
import type { AgentStore } from "../stores/agent-store";
import type { AppStore } from "../stores/app-store";

export function createAgentActions(
	appStore: AppStore,
	agentStore: AgentStore,
	client: DevEnvClient,
) {
	const openAgentView = () => {
		agentStore.setAgentSessionsLoading(true);
		agentStore.setSelectedAgentItemIndex(0);
		agentStore.setAgentSearchQuery("");
		appStore.pushView("agentView");
		client
			.getPiSessions()
			.then(agentStore.setPiAgentGroups)
			.catch((e) => {
				getLogger().write("WARN", `Failed to fetch pi sessions: ${e}`);
				agentStore.setPiAgentGroups([]);
			})
			.finally(() => agentStore.setAgentSessionsLoading(false));
	};

	const launchPi = (
		sessionPath: string | null,
		renderer: { suspend: () => void; resume: () => void },
	) => {
		const { spawnSync } =
			require("node:child_process") as typeof import("child_process");
		const projectRoot = process.env.DEVENV_HOME || process.cwd();
		renderer.suspend();
		try {
			const args: string[] = [];
			if (sessionPath) args.push("--session", sessionPath);
			spawnSync("pi", args, {
				stdio: "inherit",
				shell: false,
				cwd: projectRoot,
				env: process.env,
			});
		} finally {
			renderer.resume();
			client
				.getPiSessions()
				.then(agentStore.setPiAgentGroups)
				.catch(() => {});
		}
	};

	return { openAgentView, launchPi };
}

export type AgentActions = ReturnType<typeof createAgentActions>;
