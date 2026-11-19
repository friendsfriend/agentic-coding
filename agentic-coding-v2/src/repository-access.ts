import type { OrchestratorInfo } from "./state.ts";

/** Opening a workspace is an explicit developer grant, retained in the native
 * catalog rather than written into machine configuration. Never infer arbitrary
 * ancestors or sibling directories. Closing the last workspace revokes its grant. */
export function taskRepositories(
	configured: readonly string[],
	orchestrators: readonly OrchestratorInfo[],
): string[] {
	return [
		...new Set([
			...configured,
			...orchestrators
				.filter((entry) => entry.retiredAt === undefined)
				.map((entry) => entry.repository ?? entry.path)
				.filter(Boolean),
		]),
	];
}
