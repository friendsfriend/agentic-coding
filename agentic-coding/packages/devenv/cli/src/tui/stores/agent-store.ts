import type { AgentGroup, SshHost } from "@devenv/types";
import { createSignal } from "solid-js";

export function createAgentStore() {
	const [piAgentGroups, setPiAgentGroups] = createSignal<AgentGroup[]>([]);
	const [agentSessionsLoading, setAgentSessionsLoading] = createSignal(false);
	const [selectedAgentItemIndex, setSelectedAgentItemIndex] = createSignal(0);
	const [agentSearchQuery, setAgentSearchQuery] = createSignal("");
	const [agentFilterActive, setAgentFilterActive] = createSignal(false);
	const [sshHosts, setSshHosts] = createSignal<SshHost[]>([]);
	const [selectedSshIndex, setSelectedSshIndex] = createSignal(0);
	const [sshSearchQuery, setSshSearchQuery] = createSignal("");
	const [sshFilterActive, setSshFilterActive] = createSignal(false);

	return {
		piAgentGroups,
		setPiAgentGroups,
		agentSessionsLoading,
		setAgentSessionsLoading,
		selectedAgentItemIndex,
		setSelectedAgentItemIndex,
		agentSearchQuery,
		setAgentSearchQuery,
		agentFilterActive,
		setAgentFilterActive,
		sshHosts,
		setSshHosts,
		selectedSshIndex,
		setSelectedSshIndex,
		sshSearchQuery,
		setSshSearchQuery,
		sshFilterActive,
		setSshFilterActive,
	};
}

export type AgentStore = ReturnType<typeof createAgentStore>;
