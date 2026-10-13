// Run variables of one app instance (`make-app-runs-exclusive`,
// `add-agent-debug-tools`).
//
// An app runs once at a time with its own static names and ports, so the owner
// and the checkout directory are the only values a definition needs for
// identity. `add-agent-debug-tools` adds the OTel wiring: every run learns the
// local receiver's endpoint, the protocol it speaks, the service name it
// exports under and the resource attributes that attribute its spans.
//
// Attribution is by slot grant, not by host or port: `ac.run` changes with
// every grant, so the spans of a previous holder of the same app stay
// distinguishable even though its static address is identical. `ac.owner` is
// the workflow whose run produced the span, which is what `otel_query` scopes
// its answers by.
//
// The variables are resolved per runtime, because a container and a plain
// process do not reach the host the same way: a script runs on the host and
// talks to `127.0.0.1`, a container or a pod is given the host address the
// receiver was bound for (`src/server/receivers/bind.ts`).
import type { EnvironmentOwner } from "./model.ts";

/** The runtime shape a variable set is resolved for: a container, a plain
 * process on the host, or a pod in a cluster. */
export type InstanceRuntimeKind = "docker" | "script" | "kubernetes";

/** The OTLP HTTP receiver's standard port. A run started by a process that
 * configured no receiver of its own still receives an endpoint, so a definition
 * never has to guess one. */
export const DEFAULT_OTEL_HTTP_PORT = 4318;

/**
 * Where a run reaches the receiver that takes its spans.
 *
 * Both listeners are optional and exactly one protocol is advertised: the HTTP
 * receiver speaks OTLP/JSON, the gRPC receiver OTLP over gRPC. `containerHost`
 * is the address a container or pod uses (the host gateway, or the bridge
 * address the receiver bound); a script always uses loopback.
 */
export interface OtelReceiverTarget {
	readonly httpPort?: number;
	readonly grpcPort?: number;
	/** Host a container or a pod reaches the receiver at. */
	readonly containerHost?: string;
}

/** The endpoint one run exports to, and the protocol it speaks there. */
export interface OtelEndpoint {
	readonly endpoint: string;
	readonly protocol: "http/json" | "grpc";
}

export interface InstanceVariableContext {
	readonly owner: EnvironmentOwner;
	readonly appDir: string;
	/** The configured app the run starts: its OTel service name. */
	readonly app: string;
	readonly runtime: InstanceRuntimeKind;
	/** The slot grant this run belongs to. Fresh on every grant. */
	readonly grantId: string;
	/** The receiver this process bound. Defaults to the standard HTTP port. */
	readonly receiver?: OtelReceiverTarget;
	/**
	 * The definition's own environment. A standard OTLP variable a definition
	 * declares wins: the run receives the definition's value, and never two
	 * answers for one setting.
	 */
	readonly definitionEnv?: Readonly<Record<string, string>>;
}

/**
 * One resource-attribute value. The `k=v,k=v` list format separates on commas
 * and equals signs, so a value carrying either (or a space) would produce a
 * malformed list the receiving SDK cannot parse; those characters are replaced
 * rather than dropped, so the value stays readable in a span.
 */
function attributeValue(value: string): string {
	return value.replace(/[,\s=]+/g, "_");
}

/** The `ac.*` resource attributes of one run, in the OTLP list format. */
export function otelResourceAttributes(context: {
	readonly app: string;
	readonly owner: string;
	readonly grantId: string;
}): string {
	return [
		["ac.app", context.app],
		["ac.owner", context.owner],
		["ac.run", context.grantId],
	]
		.map(([key, value]) => `${key}=${attributeValue(value as string)}`)
		.join(",");
}

/** The receiver endpoint of one run, as its runtime reaches it. */
export function otelEndpoint(
	runtime: InstanceRuntimeKind,
	receiver: OtelReceiverTarget,
): OtelEndpoint {
	const host =
		runtime === "script"
			? "127.0.0.1"
			: (receiver.containerHost ?? "host.docker.internal");
	if (receiver.httpPort !== undefined)
		return {
			endpoint: `http://${host}:${receiver.httpPort}`,
			protocol: "http/json",
		};
	if (receiver.grpcPort !== undefined)
		return {
			endpoint: `http://${host}:${receiver.grpcPort}`,
			protocol: "grpc",
		};
	return {
		endpoint: `http://${host}:${DEFAULT_OTEL_HTTP_PORT}`,
		protocol: "http/json",
	};
}

/**
 * The values passed to a Compose file or a script: the owner, the checkout
 * directory and the OTel wiring of this run. A script additionally receives the
 * standard `OTEL_*` variables an OTel SDK reads by itself, because a plain
 * process is configured by nothing else; a container gets the `AC_OTEL_*` set
 * its definition references explicitly.
 */
export function resolveInstanceVariables(
	context: InstanceVariableContext,
): Record<string, string> {
	const variables: Record<string, string> = {
		AC_OWNER: context.owner,
		AC_APP_DIR: context.appDir,
	};
	const { endpoint, protocol } = otelEndpoint(
		context.runtime,
		context.receiver ?? { httpPort: DEFAULT_OTEL_HTTP_PORT },
	);
	const attributes = otelResourceAttributes(context);
	variables.AC_OTEL_ENDPOINT = endpoint;
	variables.AC_OTEL_PROTOCOL = protocol;
	variables.AC_OTEL_SERVICE_NAME = context.app;
	variables.AC_OTEL_RESOURCE_ATTRIBUTES = attributes;
	if (context.runtime === "script")
		for (const [key, value] of Object.entries({
			OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
			OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
			OTEL_SERVICE_NAME: context.app,
			OTEL_RESOURCE_ATTRIBUTES: attributes,
			// A definition's own value wins over the one resolved here, and is
			// still written: the run must not end up with no setting because the
			// definition expected the environment to carry one.
		}))
			variables[key] = context.definitionEnv?.[key] ?? value;
	return variables;
}
