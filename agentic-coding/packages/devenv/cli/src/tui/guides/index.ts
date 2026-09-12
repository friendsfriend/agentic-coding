export interface Guide {
	key: string;
	title: string;
	description: string;
	category: string;
	import: () => Promise<string>;
}

// ponytail: flat registry, extend by adding entries. Switch to file‑system
// scan if guides ever exceed ~20.
export const guides: Guide[] = [
	{
		key: "system-utilities",
		title: "System Utilities",
		description:
			"Required and optional system tools with installation instructions",
		category: "Setup",
		import: () =>
			import("./system-utilities.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "config-repository",
		title: "Configuration Repository",
		description: "Share DevEnv config across machines or with a team",
		category: "Setup",
		import: () =>
			import("./config-repository.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "container-runtime",
		title: "Container Runtime",
		description: "Choose Docker or Podman via DEVENV_CONTAINER_RUNTIME",
		category: "Runtimes",
		import: () =>
			import("./container-runtime.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "kubernetes-runtime",
		title: "Kubernetes Runtime",
		description: "Run Helm app and infrastructure targets on managed kind",
		category: "Runtimes",
		import: () =>
			import("./kubernetes-runtime.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "choosing-runtime",
		title: "Choosing a Runtime",
		description:
			"When to use Docker Compose, Kubernetes, shell, or script infrastructure",
		category: "Runtimes",
		import: () =>
			import("./choosing-runtime.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "combining-runtimes",
		title: "Combining Runtimes",
		description:
			"Connect Docker, Podman, shell, scripts, and Kubernetes safely",
		category: "Runtimes",
		import: () =>
			import("./combining-runtimes.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "effective-docker-builds",
		title: "Effective Docker Builds",
		description: "Write fast Dockerfiles for Docker and Podman build targets",
		category: "Builds",
		import: () =>
			import("./effective-docker-builds.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "adding-repositories",
		title: "Adding a Repository",
		description:
			"Repository definitions, Dockerfiles, Compose config, and infra linking",
		category: "Authoring",
		import: () =>
			import("./adding-repositories.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "adding-scripts",
		title: "Adding a Task",
		description:
			"Task discovery, --devenv-metadata convention, parameter types",
		category: "Authoring",
		import: () =>
			import("./adding-scripts.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "adding-infrastructure",
		title: "Adding Infrastructure",
		description: "Infra definitions, Compose placement, sharing between apps",
		category: "Authoring",
		import: () =>
			import("./adding-infrastructure.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "adding-libraries",
		title: "Adding Libraries",
		description: "Library definitions, build and test Dockerfiles",
		category: "Authoring",
		import: () =>
			import("./adding-libraries.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "using-worktrees",
		title: "Using Worktrees",
		description: "Single checkout vs worktrees, worktrunk, IDE setup",
		category: "Workflow",
		import: () =>
			import("./using-worktrees.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "custom-themes",
		title: "Custom Themes",
		description: "Create OpenCode-compatible themes in ~/.config/devenv/themes",
		category: "Customization",
		import: () =>
			import("./custom-themes.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "using-ai-features",
		title: "Using AI Features",
		description: "pi session view, sessions, pi integration",
		category: "AI",
		import: () =>
			import("./using-ai-features.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "using-git-integrations",
		title: "Using Git Integrations",
		description:
			"Providers, Change Request browsing, diff, discussions, approvals, AI review, pipelines, test results",
		category: "Git",
		import: () =>
			import("./using-git-integrations.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "using-log-viewer",
		title: "Using the Log Viewer",
		description:
			"Action history, runtime logs, search, scrolling, keyboard shortcuts",
		category: "Logs",
		import: () =>
			import("./using-log-viewer.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
	{
		key: "finding-logs",
		title: "Finding Logs",
		description: "Action retention, remaining runtime logs, server diagnostics",
		category: "Logs",
		import: () =>
			import("./finding-logs.md", { with: { type: "text" } }).then(
				(m) => m.default,
			),
	},
];

export function getGuide(key: string): Guide | undefined {
	return guides.find((g) => g.key === key);
}
