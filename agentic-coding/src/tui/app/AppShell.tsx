/** @jsxImportSource @opentui/solid */
// Unified feature-shell composition root (compose-unified-feature-shell,
// task 2.1). It owns the single OpenTUI renderer composition: the workflow /
// observability / wiki feature bodies come from the existing shell `App`, and
// the imported Environments feature is supplied as a render hook so the
// `tui-feature` layer never imports the shell.
import { type DashboardTab, App as FeatureShell } from "../otel/app/App";
import type { TraceDb } from "../otel/model/db";
import type { LogStore } from "../otel/model/logStore";
import type { MetricStore } from "../otel/model/metricStore";
import type { TopologyStore } from "../otel/model/topologyStore";
import type { TraceStore } from "../otel/model/traceStore";
import type { KeybindSection } from "../shared/keybinds";
import { EnvironmentsFeature } from "./EnvironmentsFeature";

export interface AppShellProps {
	repos: string[];
	db: TraceDb;
	traceStore: TraceStore;
	metricStore: MetricStore;
	logStore: LogStore;
	topologyStore: TopologyStore;
	tracesOnly?: boolean;
	dashboard?: DashboardTab;
	/** When the environment backend is configured, the shell exposes the
	 * Environments feature; absent, the shell keeps the workflow/observability/
	 * wiki surface only. */
	environments?: { serverUrl: string };
}

/** The one renderer entry for the unified feature shell. */
export function AppShell(props: AppShellProps) {
	return (
		<FeatureShell
			repos={props.repos}
			db={props.db}
			traceStore={props.traceStore}
			metricStore={props.metricStore}
			logStore={props.logStore}
			topologyStore={props.topologyStore}
			tracesOnly={props.tracesOnly}
			dashboard={props.dashboard}
			environments={props.environments}
			renderEnvironments={
				props.environments
					? (
							onCatalog: (catalog: KeybindSection[]) => void,
							active: () => boolean,
							onModalChange: (open: boolean) => void,
						) => (
							<EnvironmentsFeature
								serverUrl={props.environments?.serverUrl ?? ""}
								onKeybindCatalog={onCatalog}
								active={active}
								onModalChange={onModalChange}
							/>
						)
					: undefined
			}
		/>
	);
}
