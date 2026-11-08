// Native observation shape for the ported agent sidebar. No workflow adoption.
export type AgentSidebarMode = "expanding" | "permanent";
export type AgentSidebarRow = {
	key: string;
	role: string;
	workflowId: string;
	workflowStep?: string;
	status: string;
	runtime?: string;
	model?: string;
};
export const AGENT_SIDEBAR_WIDTH = 34;
export const AGENT_SIDEBAR_COLLAPSED_WIDTH = 6;
export function clampAgentListOffset(
	offset: number,
	rowCount: number,
	visibleCount: number,
): number {
	return Math.min(
		Math.max(0, Math.trunc(offset)),
		Math.max(0, rowCount - Math.max(1, Math.trunc(visibleCount))),
	);
}
export function clip(value: string, max: number): string {
	if (max <= 0) return "";
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
