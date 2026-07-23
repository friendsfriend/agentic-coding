"""argparse CLI surface + entrypoint wiring. Subcommand names/flags are the frozen external contract."""
import argparse

from . import commands, effects, transitions


def parser():
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("projects")
    sub.add_parser("config")
    start = sub.add_parser("start")
    start.add_argument("--repo", required=True)
    start.add_argument("--change", required=True)
    start.add_argument("--task", required=False)
    start.add_argument("--mode", choices=("worktree", "checkout"), required=True)
    start.add_argument("--ticket", type=str)
    start.add_argument("--worker")
    start.add_argument("--workflow-type", choices=tuple(transitions.WORKFLOW_TYPES.keys()), default="standard")
    for name in ("planner", "apply", "verify", "recover", "apply-recovery", "dispatch-verifiers", "finish-review", "archive", "close", "status", "check-timeout", "git-operations"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--repo", required=True)
        cmd.add_argument("--change", required=True)
    phase = sub.add_parser("phase")
    phase.add_argument("--repo", required=True)
    phase.add_argument("--change", required=True)
    phase.add_argument("phase")
    override = sub.add_parser("override-phase")
    override.add_argument("--repo", required=True)
    override.add_argument("--change", required=True)
    override.add_argument("phase")
    preflight = sub.add_parser("preflight-archive")
    preflight.add_argument("--repo", required=True)
    preflight.add_argument("--change", required=True)
    set_return = sub.add_parser("set-return")
    set_return.add_argument("--repo", required=True)
    set_return.add_argument("--change", required=True)
    set_return.add_argument("--workspace", required=True)
    result = sub.add_parser("verification-result")
    result.add_argument("--repo", required=True)
    result.add_argument("--change", required=True)
    result.add_argument("--role", required=True)
    message = sub.add_parser("message")
    message.add_argument("--repo", required=True)
    message.add_argument("--change", required=True)
    message.add_argument("--from", dest="sender", required=True)
    message.add_argument("--to", dest="target", required=True)
    message.add_argument("text")

    plugin = sub.add_parser("plugin")
    plugin_sub = plugin.add_subparsers(dest="plugin_command", required=True)
    plugin_sub.add_parser("list")
    plugin_install = plugin_sub.add_parser("install")
    plugin_install.add_argument("source", help="Extension source (npm package, git URL, or path)")
    plugin_install.add_argument("--worker", action="store_true", help="Assign to worker role")
    plugin_install.add_argument("--planner", action="store_true", help="Assign to planner role")
    plugin_install_local = plugin_sub.add_parser("install-local")
    plugin_install_local.add_argument("path", help="Path to local extension file (.ts, .js)")
    plugin_install_local.add_argument("--worker", action="store_true", help="Assign to worker role")
    plugin_install_local.add_argument("--planner", action="store_true", help="Assign to planner role")

    return root


def build_context():
    config = effects.load_config()
    return effects.Context(config=config, herdr=effects.Herdr(), git=effects.Git(), clock=effects.Clock(), exporter=effects.TraceExporter())


def main():
    args = parser().parse_args()
    ctx = build_context()
    if args.command == "plugin":
        commands.cmd_plugin(ctx, args)
    else:
        getattr(commands, f"cmd_{args.command.replace('-', '_')}")(ctx, args)


if __name__ == "__main__":
    main()
