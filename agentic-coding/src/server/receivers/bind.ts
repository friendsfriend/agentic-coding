// Where the telemetry receivers bind (`add-agent-debug-tools`, task 1.2).
//
// The receivers take the spans an app exports, and an app run in a container
// cannot reach host loopback. Docker Desktop and Podman machine forward
// `host.docker.internal` / `host.containers.internal` to host loopback, so a
// desktop engine needs nothing extra. A Linux engine does not, so the receiver
// also binds the container bridge gateway — the one address a container can
// reach the host at.
//
// Two guarantees hold whatever the configuration says:
//
//   * a wildcard address (`0.0.0.0`, `::`, `*`) is never bound, because these
//     listeners accept telemetry from anywhere and the local bridge network is
//     the whole audience; and
//   * nothing is bound without being asked for: `telemetry.receiver.container_bind`
//     is `auto` (the gateway, on a Linux engine), `off` (loopback only) or an
//     explicit address.
import { runtimeCommandForRuntime } from "../runtime/docker.ts";

/** `telemetry.receiver.container_bind` as configuration reads it. */
export type ReceiverContainerBind = string;

/** The addresses the receivers bind, and the host a container uses. */
export interface ReceiverBindPlan {
	/** Every address the HTTP and gRPC listeners bind, loopback first. */
	readonly hosts: string[];
	/** The address a container or pod reaches the receiver at, when the
	 * receiver bound one beyond loopback. */
	readonly containerHost?: string;
}

export interface ReceiverBindInput {
	/** Resolved configuration; `undefined` means the `auto` default. */
	readonly containerBind?: string;
	/** Test seam: the platform the engine detection is judged on. */
	readonly platform?: string;
	/** Resolves the container bridge gateway of a local engine. Asked only when
	 * `auto` needs it, and a failure means "no gateway known". */
	readonly gateway?: () => Promise<string | undefined>;
	readonly warn?: (message: string) => void;
}

/** Addresses that mean "every interface": never a receiver bind target. */
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]", "::0", "*", "any"]);

function isWildcardHost(value: string): boolean {
	return WILDCARD_BINDS.has(value.trim().toLowerCase());
}

/** An address a listener may bind: no wildcard, no control characters, and
 * short enough to be an address rather than a payload. */
function usableBind(value: string): string | undefined {
	const host = value.trim();
	if (host === "" || host.length > 255) return undefined;
	if (isWildcardHost(host)) return undefined;
	// A bind target is one address, never a list or a URL.
	if (/[\s,/]/.test(host) || host.includes("://")) return undefined;
	return host;
}

/**
 * The bind plan of this process's receivers. `auto` binds the container bridge
 * gateway only when a Linux engine is detected (a desktop engine forwards
 * `host.docker.internal` instead), and a gateway that cannot be resolved leaves
 * the receiver loopback-only rather than guessing an address.
 */
export async function planReceiverBinds(
	input: ReceiverBindInput = {},
): Promise<ReceiverBindPlan> {
	const platform = input.platform ?? process.platform;
	const requested = (input.containerBind ?? "auto").trim() || "auto";
	const hosts = ["127.0.0.1"];
	if (requested === "off") return { hosts };
	let extra: string | undefined;
	if (requested === "auto") {
		if (platform === "linux") {
			const gateway = await input.gateway?.().catch(() => undefined);
			extra = gateway === undefined ? undefined : usableBind(gateway);
			// `auto` is best effort: no installed/running engine is a normal
			// loopback-only setup, so do not emit startup noise. Explicit invalid
			// addresses still warn below.
		}
	} else if (isWildcardHost(requested)) {
		// A wildcard is refused, not clamped: silently binding something else
		// would hide a configuration that asked to expose the receiver.
		input.warn?.(
			`[receivers] ${JSON.stringify(requested)} is a wildcard address; the receivers stay loopback-only`,
		);
	} else {
		extra = usableBind(requested);
		if (extra === undefined)
			input.warn?.(
				`[receivers] ${JSON.stringify(requested)} is not an address; the receivers stay loopback-only`,
			);
	}
	if (extra === undefined || hosts.includes(extra)) return { hosts };
	return { hosts: [...hosts, extra], containerHost: extra };
}

/**
 * The container bridge gateway of a local engine, as the engine reports it.
 * `undefined` when no engine answers or reports no gateway, which leaves the
 * receivers loopback-only.
 */
export async function defaultContainerGateway(
	engineName: string,
): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(
			[
				runtimeCommandForRuntime(engineName),
				"network",
				"inspect",
				"bridge",
				"--format",
				"{{(index .IPAM.Config 0).Gateway}}",
			],
			{ stdout: "pipe", stderr: "ignore", stdin: "ignore" },
		);
		const text = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) return undefined;
		const gateway = text.trim();
		return gateway === "" ? undefined : gateway;
	} catch {
		return undefined;
	}
}
