import type { EnvironmentRun } from "../state.ts";

type ObservedRun = Omit<EnvironmentRun, "output"> & {
	endpoints?: Record<string, string>;
	output?: string;
};
const fits = (value: unknown) =>
	Buffer.byteLength(JSON.stringify(value)) <= 512;

/** Small receipt excerpts, not a complete log or provider-status history. Never cut resource IDs/URLs. */
export function runObservation(run: ObservedRun) {
	const observed =
		run.runtimeStatuses ?? (run.runtimeStatus ? [run.runtimeStatus] : []);
	const statuses: typeof observed = [];
	for (const status of observed)
		if (statuses.length < 2 && fits([...statuses, status]))
			statuses.push(status);
	const endpoints: Record<string, string> = {};
	for (const [name, url] of Object.entries(run.endpoints ?? {}))
		if (
			Object.keys(endpoints).length < 4 &&
			fits({ ...endpoints, [name]: url })
		)
			endpoints[name] = url;
	const source = run.output ?? "";
	const lines: string[] = [];
	for (const line of source.split("\n").reverse()) {
		if (!fits([line, ...lines].join("\n"))) break;
		lines.unshift(line);
	}
	const output = lines.join("\n");
	const endpointCount = Object.keys(run.endpoints ?? {}).length;
	const errorOmitted = !fits(run.error);
	return {
		id: run.id,
		app: run.plan.app,
		target: run.plan.id,
		action: run.plan.action,
		runtime: run.plan.runtime,
		state: run.state,
		ready: run.ready,
		exitCode: run.exitCode,
		signal: run.signal,
		revision: run.revision,
		error: errorOmitted
			? "Error details omitted; inspect scoped diagnostics"
			: run.error,
		...(errorOmitted ? { errorOmitted: true } : {}),
		endpoints,
		endpointWindow: {
			observed: endpointCount,
			returned: Object.keys(endpoints).length,
			omitted: endpointCount - Object.keys(endpoints).length,
		},
		...(source
			? {
					output,
					outputExcerpt: {
						sourceCodeUnits: source.length,
						returnedCodeUnits: output.length,
						truncated: source !== output,
					},
				}
			: {}),
		...(run.cleanupRetention ? { inspectionRequired: true } : {}),
		...(observed.length
			? {
					runtimeStatuses: statuses,
					runtimeStatusWindow: {
						observed: observed.length,
						returned: statuses.length,
						omitted: observed.length - statuses.length,
					},
				}
			: {}),
	};
}
