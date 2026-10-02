Not for agents. This is only for humans.

Fixes: 
* Test performance optimizations
* Verfication doenst get started based on the gating.

Big ones:
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.
* Rework existing AI features using the workflow engine (ai summary for logs etc.)
* Introduce Verfication only workflow
* Introduce Rebase workflow
* Introduce dependency upgrade and migration workflow

Small ones: 
* Improve agent steering based on recent runs (observability first)
* JEV:
  * Compaction hints
  * Use jev to block bash commands that should be blocked
