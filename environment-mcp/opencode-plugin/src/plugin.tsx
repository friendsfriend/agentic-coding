/** @jsxImportSource @opentui/solid */
import { EnvironmentPage } from "./environments/EnvironmentPage.tsx";
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
							slash: { name: "environment", aliases: ["env"] },
							palette: true,
							run: () => openEnvironment(context),
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
