Not for agents. This is only for humans.

Fixes: 

Big ones:
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.
* Rework existing AI features using the workflow engine (ai summary for logs etc.)
* Introduce dependency upgrade and migration workflow

* Implement Infrastructure and testing / debugging integration -> Devenv environments fused with agentic work
 │ #  │ Change                                  │ Needs                              │ Why here                                                                                                                        │
 │ 1  │ make-app-runs-exclusive                 │ archived add-environment-instances │ Undoes the parallel runs from step 1 and adds one run per app with waiting and toasts. Everything else builds on it.            │
 │ 2  │ add-environment-instance-lifecycle      │ 1                                  │ Apps are released when the workflow ends or sits idle, so waiting agents can't get stuck behind a forgotten app.                │
 │ 3  │ add-agent-environment-tools             │ 1, 2                               │ First change agents can use: the env_* tools, with env_start blocking while it waits.                                           │
 │ 4  │ show-environment-instances              │ 1, 2                               │ As soon as agents hold apps, you can see who holds and who waits, and force-release.                                            │
 │ 5  │ add-workflow-evidence-store             │ —                                  │ Storage the browser needs. It has no dependencies, so it can also run in parallel with 1–4.                                     │
 │ 6  │ add-dashboard-evidence-panel            │ 5                                  │ Shows evidence in the dashboard before the agents start producing it.                                                           │
 │ 7  │ add-agent-browser-sessions              │ 3, 5                               │ Headless browser, screenshots and video.                                                                                        │
 │ 8  │ add-agent-debug-tools                   │ 1, 3                               │ OTel wiring and otel_query / db_query / http_request.                                                                           │
 │ 9  │ add-environment-setup-workflow          │ 1, 3, 8                            │ Agents write the run definitions, including the OTel wiring from 8.                                                             │
 │ —  │ Operational: one env-setup pass per app │ 9                                  │ Adds OTel wiring and a mock-auth profile to your existing apps, so the debug tools return useful data.                          │
 │ 10 │ add-debug-workflow                      │ 3, 5, 7, 8                         │ The debug role and the standalone debug workflow with your review step.                                                         │
 │ 11 │ add-debug-subagent-requests             │ 10                                 │ Other agents can hand work to the debug agent asynchronously.                                                                   │
 │ 12 │ add-kubernetes-run-replicas             │ 1                                  │ Optional kind runs with multiple replicas. It only needs 1, so it can go anywhere after it; it's last because it matters least. │

Small ones: 
* Improve agent steering based on recent runs (observability first)
* JEV:
  * Compaction hints
  * Use jev to block bash commands that should be blocked
  * Improve jev quality by using better input
* Orchestrator 
  * Improve tool descriptions so that orchestrator instantly knows which data to request from the user first -> e.g model preset and so on
  * If no default is set in the menu -> Show message in transcript as red error for the user to select /model and /thinking before asking questions
