import type { EnvironmentCapabilities } from "../interface/capabilities.ts";
import {
	type ActionDescriptor,
	describeAction,
} from "../interface/descriptors.ts";

export type UiActionDescriptor = ActionDescriptor;
export type UiCapabilityApi = {
	list(): Promise<readonly UiActionDescriptor[]>;
	invoke(
		name: string,
		input: unknown,
		options?: { signal?: AbortSignal },
	): Promise<Record<string, unknown>>;
};

/** Server-independent UI entry point. Standalone OpenTUI and the OpenCode plugin
 * both consume this interface; they never import MCP registration, listeners or
 * service internals. An in-process registry and a remote proxy are both valid
 * implementations of the same contract. */
export function createUiCapabilityApi(
	capabilities: EnvironmentCapabilities,
): UiCapabilityApi {
	return {
		async list() {
			return capabilities.list().map(describeAction);
		},
		invoke(name, input, options) {
			const controller = new AbortController();
			const signal = options?.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal;
			return capabilities.invoke(name, input, { signal });
		},
	};
}
