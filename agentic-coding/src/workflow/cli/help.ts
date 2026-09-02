// Top-level and per-command usage text. Moved verbatim out of cli.ts
// (split-workflow-god-modules).
export function help(command?: string): void {
	if (!command) {
		console.log(
			"Usage: agentic-coding workflow <command> [flags]\n\nCommands:\n  start            Start pinned workflow definition\n  status           Print validated workflow view\n  action           Dispatch revision-bound engine action (including close-research)\n  handoff          Submit run-bound agent outcome\n  question         Ask the developer a bounded question\n  research-handoff Record structured handoff and start wiki drafting\n  repair           Repair to compatible step, retriggers phase\n  repin            Re-pin to current definition digest\n  projects         List configured projects\n  config           Print resolved configuration\n  agent-extension  Manage Pi agent extensions\n  wiki             Read/update OKF wiki; only the managed wiki or research-wiki role may write drafts; archive verifies",
		);
		return;
	}
	const usage: Record<string, string> = {
		start:
			"start [--repo PATH] --workflow-id ID [--mode worktree|checkout] [--workflow openspec-full|openspec-propose|openspec-apply|no-openspec|openspec-fusion-full|openspec-fusion-propose|wiki|research] [--fusion-profiles NAME,NAME,...] [--task TEXT] [--ticket ID] [--preset NAME]",

		status: "status --repo PATH --workflow-id ID",
		action:
			"action ACTION_ID --repo PATH --workflow-id ID --revision N [--input JSON_OR_PATH]",
		handoff:
			"handoff --outcome complete|blocked|failed [--artifact PATH] [--message TEXT]",
		question:
			"question [--description TEXT | --questions JSON] [--context TEXT] [--options JSON] [--timeout MILLISECONDS]",
		"research-handoff":
			"research-handoff --subject TEXT --directives JSON_OR_PATH [--target TEXT] [--findings TEXT] [--citations TEXT,TEXT] [--no-sources]; records the structured handoff and transitions to wiki drafting in one authenticated step. --directives is a JSON array of { target, intent: create|update, claims: [TEXT], citations?: [TEXT] }",
		repair:
			"repair --repo PATH --workflow-id ID --revision N --step STEP [--reason TEXT] [--confirm]",
		projects: "projects",
		config: "config",
		"agent-extension":
			"agent-extension list|install SOURCE|install-local PATH [--profile NAME]",
		wiki: "wiki list|search TERMS|show ID|write --path ID --type T --title T --description D|verify --path ID [--actor A]|log --entry TEXT [--path DIR]",
	};
	console.log(`Usage: agentic-coding workflow ${usage[command] ?? command}`);
}
