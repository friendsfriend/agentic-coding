Not for agents. This is only for humans.

Fixes: 
* Fix question option for worker -> Planner / consolidator
* Fix minor ui stuff (Weird texts in new workflow modal)
* All openspec files are shown in the openspec panel instead of only the newly created ones
* Traces are not shown properly (new ones are missing)
* Fix workflow tab name matching. Currently it fails to discover the agents due to the agent state glyphs
* Some findings dont show up in the diff
* Findings cant be toggled with space
* The agent status in the dashboard doenst work anymore

Big ones:
* Implement Agent steered version of the workflow. Basically an orchestrator version of the workflow.
* Implement subagent system for workers
* Integrate devenv and this into one tui / system
  * Follow up: Make devenv apps also have the option to use the otel traces
* Move the otel observability into a single tab with subviews for metrics, logs, traces and topology

Small ones: 
* Automatic wiki commit + push if in git repo.
* Give all agents their own tab. Multitab spawning always has issues for some reason

