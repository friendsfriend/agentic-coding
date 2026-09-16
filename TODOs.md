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
* Remove tabs from agentic-coding dash -> Not needed as it should only serve as a implementation dashboard
* Think of a better UI concept for the two tab bars. Maybe breadcrumbs and a menu structure or so. 


UI Rework / Devenv union: 
* Review tests and add guardrails on what tests to write (in progress)
* Test everything
* Embed breadcrumbs in header (spec created)
* Change behavior of page navigation to jump up one page using esc (spec created)
* Spacing between footer and header unified to 1 space
    * Adding an app doenst work in the applications view

