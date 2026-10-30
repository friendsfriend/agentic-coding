// Compatibility import site: bootstrap belongs to the non-TUI host boundary.
export {
	currentSessionName,
	type OrchestratorModel,
	type OrchestratorSession,
	openOrchestratorSession,
	orchestratorHostEnv,
	orchestratorRuntimeDir,
	submitOrchestratorDeveloperInput,
} from "../../agent-host/orchestrator-session.ts";
