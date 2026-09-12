import type { ClientDeps } from "./client-types";

export async function createExampleConfig(deps: ClientDeps): Promise<void> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/example-config`, {
		method: "POST",
	});
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			const data = (await response.json()) as { error?: string };
			message = data.error || message;
		} catch {}
		throw new Error(message);
	}
}
