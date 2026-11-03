import { toolResult } from "../agent-tools.ts";
export function environmentResult(value: unknown) {
	const encoded = JSON.stringify(value);
	return toolResult(
		encoded.length > 40000
			? `${encoded.slice(0, 39500)}\n[truncated; narrow env_status/env_logs to an app]`
			: encoded,
	);
}
