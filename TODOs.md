Not for agents. This is only for humans.

Fixes: 

Big ones:
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.
* Rework existing AI features using the workflow engine (ai summary for logs etc.)
* Introduce dependency upgrade and migration workflow

Small ones: 
* Improve agent steering based on recent runs (observability first)
* JEV:
  * Use jev to block bash commands that should be blocked
  * Improve jev quality by using better input
* Make the server be deployable on a server
  * User handling
  * Repository handling
* Multi Repository workflows for cross app testing
