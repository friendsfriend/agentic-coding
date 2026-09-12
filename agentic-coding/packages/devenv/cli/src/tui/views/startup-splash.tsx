/** @jsxImportSource @opentui/solid */
import type { AppStore, StartupPhase } from "../stores";
import {
	ProgressSplash,
	type ProgressSplashStepStatus,
} from "./progress-splash";

interface StartupSplashProps {
	appStore: AppStore;
}

const phaseLabels: Record<Exclude<StartupPhase, "failed">, string> = {
	connecting: "Connecting to server",
	"server-ready": "Server ready",
	"loading-action-registry": "Loading action definitions",
	"loading-applications": "Loading applications",
	"loading-scripts": "Loading scripts",
	"loading-providers": "Loading providers",
	"loading-infrastructure": "Loading infrastructure",
	complete: "Startup complete",
};

const phaseOrder: Exclude<StartupPhase, "failed">[] = [
	"connecting",
	"server-ready",
	"loading-action-registry",
	"loading-applications",
	"loading-scripts",
	"loading-providers",
	"loading-infrastructure",
	"complete",
];

function phaseStatus(
	current: StartupPhase,
	phase: Exclude<StartupPhase, "failed">,
): ProgressSplashStepStatus {
	if (current === "failed") return "pending";
	const currentIndex = phaseOrder.indexOf(current);
	const phaseIndex = phaseOrder.indexOf(phase);
	if (phaseIndex < currentIndex) return "done";
	if (phaseIndex === currentIndex) return "current";
	return "pending";
}

export function StartupSplash(props: StartupSplashProps) {
	const state = () => props.appStore.startupState();
	const currentPhase = () => state().phase;
	const isFailed = () => currentPhase() === "failed" || Boolean(state().error);

	return (
		<ProgressSplash
			title="DevEnv Startup"
			message={state().message}
			steps={phaseOrder
				.filter((phase) => phase !== "complete")
				.map((phase) => ({ phase, label: phaseLabels[phase] }))}
			statusForStep={(phase) => phaseStatus(currentPhase(), phase)}
			failed={isFailed()}
			failureTitle="Connection failed"
			failureDetail={state().error || state().message}
			failureHint="Quit and restart to retry."
			failureMessage="Inspect server logs at $DEVENV_HOME/logs/server.log or ~/devenv/logs/server.log."
		/>
	);
}
