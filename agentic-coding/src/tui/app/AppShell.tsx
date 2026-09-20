/** @jsxImportSource @opentui/solid */
// Unified feature-shell composition root (compose-unified-feature-shell,
// task 2.1). It owns the single OpenTUI renderer composition: the workflow /
// observability / wiki feature bodies come from the existing shell `App`, and
// the imported Environments feature is supplied as a render hook so the
// `tui-feature` layer never imports the shell.

import type { KeybindSection } from "@ui";
import { type DashboardTab, App as FeatureShell } from "../otel/app/App.tsx";
import type { LogStore } from "../otel/model/logStore.ts";
import type { MetricStore } from "../otel/model/metricStore.ts";
import type { TelemetryDb } from "../otel/model/telemetry-db.ts";
import type { TopologyStore } from "../otel/model/topologyStore.ts";
import type { TraceStore } from "../otel/model/traceStore.ts";
import { EnvironmentsFeature } from "./EnvironmentsFeature.tsx";

export interface AppShellProps {
	repos: string[];
	db: TelemetryDb;
	traceStore: TraceStore;
	metricStore: MetricStore;
	logStore: LogStore;
	topologyStore: TopologyStore;
	tracesOnly?: boolean;
	dashboard?: DashboardTab;
	/** When the environment backend is configured, the shell exposes the
	 * Environments feature; absent, the shell keeps the workflow/observability/
	 * wiki surface only. `attached` marks a backend this process does not own. */
	environments?: { serverUrl: string };
	attached?: boolean;
	/** Explicit attached-surface label rendered in the header. */
	attachLabel?: string;
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
			attached={props.attached}
			attachLabel={props.attachLabel}
			renderEnvironments={
				props.environments
					? (
							onCatalog: (catalog: KeybindSection[]) => void,
							active: () => boolean,
							onModalChange: (open: boolean) => void,
							destination: () =>
								| {
										category?: string;
										view?: string;
										onChange?: (destination: {
											category: string;
											view: string;
											resourceId?: string;
										}) => void;
								  }
								| undefined,
							onStartWorkflow: (project: {
								ident: string;
								name: string;
								repository: string;
							}) => void,
						) => (
							<EnvironmentsFeature
								serverUrl={props.environments?.serverUrl ?? ""}
								onKeybindCatalog={onCatalog}
								active={active}
								onModalChange={onModalChange}
								destination={destination}
								onStartWorkflow={onStartWorkflow}
							/>
						)
					: undefined
			}
		/>
	);
}
