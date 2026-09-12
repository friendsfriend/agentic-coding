/** @jsxImportSource @opentui/solid */
import type { AppStore } from "../stores";
import {
	getShutdownPhaseStatus,
	SHUTDOWN_PHASE_LABELS,
	SHUTDOWN_PHASE_ORDER,
} from "../stores";
import { ProgressSplash } from "./progress-splash";

interface ShutdownSplashProps {
	appStore: AppStore;
}

export function ShutdownSplash(props: ShutdownSplashProps) {
	const state = () => props.appStore.shutdownState();
	const isFailed = () => state().phase === "failed" || Boolean(state().error);

	return (
		<ProgressSplash
			title="DevEnv Shutdown"
			message={state().message || "Shutting down DevEnv..."}
			steps={SHUTDOWN_PHASE_ORDER.map((phase) => ({
				phase,
				label: SHUTDOWN_PHASE_LABELS[phase],
			}))}
			statusForStep={(phase) => getShutdownPhaseStatus(state(), phase)}
			failed={isFailed()}
			failureTitle="Shutdown failed"
			failureDetail={state().error || state().message}
			failureHint="Falling back to immediate terminal cleanup."
			failureMessage="Some background cleanup may have been interrupted."
		/>
	);
}
