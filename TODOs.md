Not for agents. This is only for humans.

Fixes: 
* Observation failed: JSON Parse error: Unterminated string
* Findings in the developer review dont show which reviewer marked the issue. Also it doesnt show a recommendation for a solution. It is just a text. I want it to have two parts: What is the issue? How can it be solved?

Big ones:
* Implement Agent steered version of the workflow. Basically an orchestrator version of the workflow.
* Implement subagent system for workers
* Integrate devenv and this into one tui / system
  * Follow up: Make devenv apps also have the option to use the otel traces
* Move the otel observability into a single tab with subviews for metrics, logs, traces and topology

Small ones: 
* Give all agents their own tab. Multitab spawning always has issues for some reason
* Improve agent steering based on recent runs (observability first)

