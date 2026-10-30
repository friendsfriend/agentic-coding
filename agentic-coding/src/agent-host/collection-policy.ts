// Reviewed execution allowlist, not provider descriptions or model prompts.
// A generic MCP dispatcher must pass BOTH the outer-tool and inner-method gate.
const directReads = new Set([
	"pi__tools_jira_cloud__jira_cloud_search",
	"pi__tools_jira_cloud__jira_cloud_get_issue",
	"pi__tools_jira_cloud__jira_cloud_get_comments",
	"pi__tools_jira_cloud__jira_cloud_get_projects",
	"pi__tools_gitlab__gitlab_mr_get",
	"pi__tools_gitlab__gitlab_mr_get_diff",
	"pi__tools_gitlab__gitlab_mr_list_comments",
	"mcp__wiz__discover",
	"pi__index__gitlab_search_merge_requests",
	"mcp__index__gitlab_search_merge_requests",
]);
// Metadata inspected via Wiz MCP discovery, never inferred from arbitrary
// `list_*` naming. Unsupported domains remain explicit coverage gaps.
const wizReads = new Set([
	"list_issues",
	"list_posture_issues",
	"list_attack_surface_findings",
]);
function canonical(name: string): string {
	const value = name.replaceAll("-", "_");
	// The same reviewed MCP sources may arrive directly or via Pi's bridge.
	return value.startsWith("mcp__tools_")
		? `pi__${value.slice("mcp__".length)}`
		: value;
}
export function collectionToolVisible(name: string): boolean {
	const key = canonical(name);
	return directReads.has(key) || key === "mcp__wiz__execute";
}
export function boundGitLabProjects<
	T extends { readonly host: string; readonly project: string },
>(projects: readonly T[], configuredToolHost: string | undefined): T[] {
	return configuredToolHost
		? projects.filter((project) => project.host === configuredToolHost)
		: [];
}
export function collectionCallAllowed(
	name: string,
	args: Readonly<Record<string, unknown>>,
	projects: readonly string[] = [],
): boolean {
	const key = canonical(name);
	if (directReads.has(key)) {
		if (key.includes("gitlab")) {
			// Validate the argument THIS reviewed provider actually consumes. An
			// ignored alias must never authorize its foreign/default project_id.
			const argument = key.includes("__index__") ? "project_id" : "project";
			const alternate = argument === "project" ? "project_id" : "project";
			const project = args[argument];
			if (typeof project !== "string" || args[alternate] !== undefined)
				return false;
			try {
				return (
					projects.includes(project) ||
					projects.includes(decodeURIComponent(project))
				);
			} catch {
				return false;
			}
		}
		return true;
	}
	if (
		key !== "mcp__wiz__execute" ||
		typeof args.tool_name !== "string" ||
		!wizReads.has(args.tool_name)
	)
		return false;
	return Object.keys(args).every(
		(property) => property === "tool_name" || property === "parameters",
	);
}
