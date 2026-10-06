// Top-level and per-command usage text. Moved verbatim out of cli.ts
// (split-workflow-god-modules).
export function help(command?: string): void {
	if (!command) {
		console.log(
			"Usage: agentic-coding workflow <command> [flags]\n\nCommands:\n  start            Start pinned workflow definition\n  status           Print observational workflow view\n  drain            Explicitly execute due workflow effects\n  action           Dispatch revision-bound engine action (including close-research)\n  handoff          Submit run-bound agent outcome\n  question         Ask the developer a bounded question\n  ask              Ask a completed peer agent a bounded question\n  answer           Answer a peer agent question (peer session only)\n  research-handoff Record structured handoff and start wiki drafting\n  repair           Repair to compatible step, retriggers phase\n  repin            Re-pin to current definition digest\n  migrate          Preview or apply a revision-bound semantic migration\n  projects         List configured projects\n  config           Print resolved configuration\n  agent-extension  Manage Pi agent extensions\n  wiki             Read/update OKF wiki; only the managed wiki or research-wiki role may write drafts; archive verifies\n",
		);
		return;
	}
	const usage: Record<string, string> = {
		start:
			"start --workflow-id ID [--repo PATH --mode worktree|checkout] [--workflow openspec|openspec-propose|openspec-apply|no-openspec|solo|rebase|openspec-fusion|openspec-fusion-propose|wiki|research] [--task TEXT] [--ticket ID] [--preset NAME] [--branch BRANCH --onto REF] (repo and mode are required except for research; classifier-routed workflows require a preset with model pools; config is repository-scoped; a rebase start also needs --branch and --onto, and runs in the repository checkout)",

		status: "status --repo PATH --workflow-id ID",
		drain: "drain --repo PATH [--limit N] [--wait-ms N]",
		action:
			"action ACTION_ID --repo PATH --workflow-id ID --revision N [--input JSON_OR_PATH]",
		handoff:
			"handoff --outcome complete|blocked|failed [--artifact PATH] [--message TEXT]",
		question:
			"question [--description TEXT | --questions JSON] [--context TEXT] [--options JSON] [--timeout MILLISECONDS]",
		ask: "ask --role ROLE --description TEXT [--context TEXT] [--options JSON] [--timeout MILLISECONDS]",
		answer:
			"answer --question-id ID --nonce NONCE --answer TEXT (only from the peer session the engine prompted)",
		"research-handoff":
			"research-handoff --subject TEXT --directives JSON_OR_PATH [--target TEXT] [--findings TEXT] [--citations TEXT,TEXT] [--no-sources]; records the structured handoff and transitions to wiki drafting in one authenticated step. --directives is a JSON array of { target, intent: create|update, claims: [TEXT], citations?: [TEXT] }",
		repair:
			"repair --repo PATH --workflow-id ID --revision N --step STEP [--reason TEXT] [--confirm]",
		migrate:
			"migrate --repo PATH --workflow-id ID --revision N --target-version N --reason TEXT [--confirm]",
		projects: "projects",
		config: "config",
		wiki: "wiki list|search TERMS|show ID|write --path ID --type T --title T --description D|verify --path ID [--actor A]|log --entry TEXT [--path DIR]",
	};
	console.log(`Usage: agentic-coding workflow ${usage[command] ?? command}`);
}
