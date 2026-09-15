// Bun-owned container/Kubernetes operation dispatch
// (`port-environment-runtimes-to-bun`, task 4.1).
//
// `port-action-execution-to-bun` dispatched the four SDK-only operations to the
// private Go child through `actions/runtime-adapter.ts`. The container lifecycle
// operations and the cluster refresh now have Bun implementations, so this is
// the owner: the operation set stays closed and literal, Bun stays the sole run
// and history owner (the dispatch allocates no run tree), and cancellation
// propagates into the runtime request. A result that arrives after the caller
// cancelled never publishes.
import type { RuntimeOperationDispatch } from "../actions/routes.ts";
import type { DockerRuntimeSelection } from "./docker.ts";
import type { KubernetesClusterService } from "./kubernetes.ts";

/** Every operation this dispatch accepts. */
export const BUN_RUNTIME_OPERATIONS = [
	"docker.container.start",
	"docker.container.stop",
	"docker.container.restart",
	"kubernetes.cluster.refresh",
] as const;

export type BunRuntimeOperation = (typeof BUN_RUNTIME_OPERATIONS)[number];

export function isBunRuntimeOperation(
	operation: string,
): operation is BunRuntimeOperation {
	return (BUN_RUNTIME_OPERATIONS as readonly string[]).includes(operation);
}

export interface BunRuntimeDispatchOptions {
	/** The selected container runtime, or `undefined` when none is available. */
	readonly docker?: DockerRuntimeSelection;
	readonly kubernetes?: KubernetesClusterService;
}

/**
 * A result that arrived after the caller was no longer the owner. The engine
 * never sees it: the dispatch checks ownership after every await and throws, so
 * a cancelled operation cannot report success.
 */
export class LateRuntimeResultError extends Error {
	constructor(operation: string) {
		super(`runtime operation ${operation} returned after its owner changed`);
		this.name = "LateRuntimeResultError";
	}
}

export function createBunRuntimeDispatch(
	options: BunRuntimeDispatchOptions,
): RuntimeOperationDispatch {
	return {
		async execute(request) {
			if (!isBunRuntimeOperation(request.operation)) {
				return {
					ok: false,
					output: "",
					error: `unsupported runtime operation ${JSON.stringify(request.operation)}`,
				};
			}
			if (request.signal.aborted) {
				return { ok: false, output: "", error: "operation canceled" };
			}
			switch (request.operation) {
				case "docker.container.start":
				case "docker.container.stop":
				case "docker.container.restart": {
					const client = options.docker?.client;
					if (!client) {
						return {
							ok: false,
							output: "",
							error: "no container runtime available",
						};
					}
					const containerId = request.containerId ?? "";
					if (containerId === "") {
						return {
							ok: false,
							output: "",
							error: "containerId is required",
						};
					}
					try {
						if (request.operation === "docker.container.start") {
							await client.startContainer(containerId);
						} else if (request.operation === "docker.container.stop") {
							await client.stopContainer(containerId);
						} else {
							await client.restartContainer(containerId);
						}
					} catch (error) {
						if (request.signal.aborted) {
							throw new LateRuntimeResultError(request.operation);
						}
						return {
							ok: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
					if (request.signal.aborted) {
						throw new LateRuntimeResultError(request.operation);
					}
					return {
						ok: true,
						output: `${request.operation} ${containerId} succeeded`,
					};
				}
				case "kubernetes.cluster.refresh": {
					const service = options.kubernetes;
					if (!service) {
						return {
							ok: false,
							output: "",
							error: "no Kubernetes capability available",
						};
					}
					let status: { state: string; exists: boolean };
					try {
						status = await service.status(request.signal);
					} catch (error) {
						if (request.signal.aborted) {
							throw new LateRuntimeResultError(request.operation);
						}
						return {
							ok: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
					if (request.signal.aborted) {
						throw new LateRuntimeResultError(request.operation);
					}
					return {
						ok: true,
						output: `cluster ${status.state}`,
					};
				}
			}
		},
	};
}
