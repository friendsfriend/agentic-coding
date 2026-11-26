/** @jsxImportSource @opentui/solid */
import { EnvironmentPage } from "./environments/EnvironmentPage.tsx";
import {
	requestSessionGit,
	requestSessionProvider,
} from "./environments/session.ts";
import type { Context, PluginDefinition, Route } from "./opencode-types.ts";

const previous: { route: Route } = { route: { type: "home" } };

function open(context: Context) {
	const current = context.ui.router.current();
	if (current.type === "plugin" && current.name === "environment") return;
	previous.route = { ...current };
	context.ui.dialog.clear();
	context.ui.router.navigate({ type: "plugin", name: "environment" });
}

function close(context: Context) {
	const route = previous.route;
	if (route.type === "plugin" && route.name === "environment") {
		context.ui.router.navigate({ type: "home" });
		return;
	}
	context.ui.router.navigate(route);
}

/** In a session, open the environment in the host's right-hand panel. Outside
 * a session there is no panel host, so fall back to the full-screen route. */
function openEnvironment(context: Context) {
	const current = context.ui.router.current();
	if (
		current.type === "session" &&
		context.ui.panel.open("environment", { presentation: "panel" })
	)
		return;
	open(context);
}

function sessionDirectory(context: Context) {
	const configured = context.options.directory ?? context.options.cwd;
	if (typeof configured === "string" && configured.trim())
		return configured.trim();
	return process.cwd();
}

function openSessionGit(context: Context) {
	requestSessionGit(sessionDirectory(context));
	openEnvironment(context);
}

function openSessionProvider(context: Context, kind: "issues" | "changes") {
	requestSessionProvider(sessionDirectory(context), kind);
	openEnvironment(context);
}

export const EnvironmentPlugin: PluginDefinition = {
	id: "environment-mcp",
	setup(context) {
		context.ui.router.register({
			name: "environment",
			render: () => (
				<EnvironmentPage context={context} onClose={() => close(context)} />
			),
		});
		context.ui.slot({
			append: "app",
			render: () => {
				context.keymap.layer(() => ({
					mode: "global",
					commands: [
						{
							id: "environment.open",
							title: "Environment",
							description: "Browse and run environment-mcp capabilities",
							group: "Environment",
							bind: "<leader>v",
							slash: { name: "environment" },
							palette: true,
							run: () => openEnvironment(context),
						},
						{
							id: "environment.gitSession",
							title: "Git actions for current directory",
							description:
								"Open git branches and actions for the agent working directory",
							group: "Environment",
							bind: "<leader>shift+g",
							slash: { name: "git" },
							palette: true,
							run: () => openSessionGit(context),
						},
						{
							id: "environment.issuesSession",
							title: "Issues for current directory",
							description:
								"Open configured provider issues for the current repository",
							group: "Environment",
							slash: { name: "issues" },
							palette: true,
							run: () => openSessionProvider(context, "issues"),
						},
						{
							id: "environment.changesSession",
							title: "Changes for current directory",
							description:
								"Open configured provider change requests for the current repository",
							group: "Environment",
							slash: { name: "changes" },
							palette: true,
							run: () => openSessionProvider(context, "changes"),
						},
					],
				}));
				return null;
			},
		});
		context.ui.slot({
			append: "session.panel",
			render: (input) => {
				if (input.name !== "environment") return null;
				return (
					<EnvironmentPage
						context={context}
						panel={input}
						onClose={input.close}
					/>
				);
			},
		});
		context.ui.slot({
			append: "home.footer.status",
			render: () => (
				<text
					fg={context.theme.text.muted}
					onMouseUp={() => open(context)}
					wrapMode="none"
				>
					<span style={{ fg: context.theme.text.feedback.info.base }}>●</span>{" "}
					Environment
				</text>
			),
		});
	},
};
