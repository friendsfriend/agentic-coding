Not for agents. This is only for humans.

Fixes: 
* Still some of the errors appear inline in the tui instead of via the notification system / tracing
* tracing info is missing, no custom properties in tui. observability not good currently
* Remove info notifation for new traces

Big ones:
* Implement Agent steered version of the workflow. Basically an orchestrator version of the workflow.
* Implement subagent system for workers
* Integrate devenv and this into one tui / system
  * Follow up: Make devenv apps also have the option to use the otel traces
* Move the otel observability into a single tab with subviews for metrics, logs, traces and topology
* Introduce performance verifier

Small ones: 
* Automatic wiki commit + push if in git repo.
* Wiki should introduce source mechanism -> Each information should also give a source (either code file or url to source). This allows to recheck the information. Should be done when reading the wiki.
* Give all agents their own tab. Multitab spawning always has issues for some reason
* Improve agent steering based on recent runs

