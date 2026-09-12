import type { ActionCommand, ActionRun, ActionStep } from "@devenv/types";
import { actionRunDisplayLabel } from "@devenv/types";
import type { ActionTreeNode } from "../stores/action-run-store";

const statusIcon = (status: string) =>
	status === "completed"
		? "✓"
		: status === "failed" || status === "canceled"
			? "✗"
			: status === "active"
				? "…"
				: "○";
const isHiddenRoot = (step: ActionStep) =>
	!step.parentId && /^Start application: /.test(step.label);

function commandLog(command: ActionCommand): string {
	const lines = [`$ ${command.command}`];
	if (command.stdout.trimEnd()) lines.push(command.stdout.trimEnd());
	if (command.stderr.trimEnd()) lines.push(command.stderr.trimEnd());
	if (command.status === "completed")
		lines.push(`[exit ${command.exitCode ?? 0}]`);
	if (command.status === "failed")
		lines.push(
			`[exit ${command.exitCode ?? "failed"}]${command.error ? ` ${command.error}` : ""}`,
		);
	return lines.join("\n");
}

function stepLabel(step: ActionStep): string {
	const prefix = step.sharedReference ? "↳ " : "";
	const suffix =
		step.outcome === "already-running"
			? " (already running)"
			: step.sharedReference
				? " (shared)"
				: "";
	return `${prefix}${step.label}${suffix}`;
}

function stepLog(step: ActionStep): string {
	if (step.sharedReference)
		return step.canonicalId
			? `[shared execution: ${step.canonicalId}]`
			: "[shared execution]";
	const logs = step.commands.map(commandLog).filter(Boolean);
	if (logs.length > 0) return logs.join("\n\n");
	return step.error ? `[error] ${step.error}` : "";
}

function childrenByParent(run: ActionRun): Map<string, ActionStep[]> {
	const hiddenRoots = new Set(
		run.steps.filter(isHiddenRoot).map((step) => step.id),
	);
	const children = new Map<string, ActionStep[]>();
	for (const step of run.steps) {
		if (hiddenRoots.has(step.id)) continue;
		const parentId =
			step.parentId && hiddenRoots.has(step.parentId)
				? ""
				: (step.parentId ?? "");
		const list = children.get(parentId) ?? [];
		list.push(step);
		children.set(parentId, list);
	}
	return children;
}

/**
 * Formats selected action-tree node and every descendant for clipboard use.
 * Tree expansion state does not affect output: copying a node always includes
 * its complete subtree. Command text/output remains verbatim, while each node
 * retains its concise UI label and status icon.
 */
export function actionTreeCopyText(
	node: Exclude<ActionTreeNode, { kind: "loadOlder" }>,
	formatProfileLabel: (profile?: string) => string,
): string {
	const run = node.run;
	const children = childrenByParent(run);
	const hiddenRoot = run.steps.find(isHiddenRoot);
	const output: string[] = [];

	const visit = (
		label: string,
		status: string,
		log: string,
		stepId: string,
		depth: number,
	) => {
		const childSteps = children.get(stepId) ?? [];
		const prefix = "    ".repeat(depth);
		output.push(
			`${prefix}${childSteps.length > 0 ? "▾ " : ""}${statusIcon(status)} ${label}`,
		);
		if (log) output.push(log);
		for (const child of childSteps)
			visit(
				stepLabel(child),
				child.status,
				stepLog(child),
				child.id,
				depth + 1,
			);
	};

	if (node.kind === "action") {
		// Multi-step runs hide their synthetic "Start application" root in tree.
		// Its command log belongs to action row; its children remain direct action
		// descendants, matching visible tree structure.
		visit(
			actionRunDisplayLabel(run, formatProfileLabel),
			run.status,
			hiddenRoot ? stepLog(hiddenRoot) : "",
			"",
			0,
		);
	} else {
		visit(
			stepLabel(node.step),
			node.step.status,
			stepLog(node.step),
			node.step.id,
			0,
		);
	}
	return output.join("\n\n");
}
