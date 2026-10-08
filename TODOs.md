Not for agents. This is only for humans.

Fixes: 

Big ones:
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.
* Rework existing AI features using the workflow engine (ai summary for logs etc.)
* Introduce dependency upgrade and migration workflow

* Implement Infrastructure and testing / debugging integration -> Devenv environments fused with agentic work
 ┌────┬───────────────────────────────────────┬────────────┬──────────────┐
 │ #  │ Change                                │ Depends on │ Size (tasks) │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 1  │ add-environment-instances             │ —          │ 12           │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 2  │ add-instance-infra-isolation          │ 1          │ 9            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 3  │ add-environment-instance-lifecycle    │ 1          │ 8            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 4  │ add-kubernetes-environment-instances  │ 1, 3       │ 9            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 5  │ template-existing-environment-configs │ 1, 2       │ 7            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 6  │ add-agent-environment-tools           │ 1, 3       │ 8            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 7  │ add-workflow-evidence-store           │ —          │ 6            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 8  │ add-agent-browser-sessions            │ 6, 7       │ 10           │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 9  │ add-agent-debug-tools                 │ 2, 6       │ 9            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 10 │ add-dashboard-evidence-panel          │ 7          │ 6            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 11 │ show-environment-instances            │ 1, 3       │ 5            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 12 │ add-debug-workflow                    │ 6–9        │ 9            │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 13 │ add-debug-subagent-requests           │ 12         │ 10           │
 ├────┼───────────────────────────────────────┼────────────┼──────────────┤
 │ 14 │ add-environment-setup-workflow        │ 1, 2, 5, 6 │ 11           │
 └────┴───────────────────────────────────────┴────────────┴──────────────┘

Small ones: 
* Improve agent steering based on recent runs (observability first)
* JEV:
  * Compaction hints
  * Use jev to block bash commands that should be blocked
  * Improve jev quality by using better input

