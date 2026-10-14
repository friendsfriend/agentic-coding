Not for agents. This is only for humans.

Fixes: 

Big ones:
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.
* Rework existing AI features using the workflow engine (ai summary for logs etc.)
* Introduce dependency upgrade and migration workflow

Small ones: 
* Implement compaction feature 
  * Use pi durable compaction range to allow the agent to decide when to compact
  * Make compaction triggerable manually from the chat
* Improve agent steering based on recent runs (observability first)
* JEV:
  * Compaction hints
  * Use jev to block bash commands that should be blocked
  * Improve jev quality by using better input
* Orchestrator 
  * Improve tool descriptions so that orchestrator instantly knows which data to request from the user first -> e.g model preset and so on
  * If no default is set in the menu -> Show message in transcript as red error for the user to select /model and /thinking before asking questions
  * Orchestrator can decide about what he wants to get notified. Implement event system for workflows that orchestrator can subscribe to on demand
* Improve mouse navigation. Many components currently dont support mouse clicking (agents panel, and so on)
* Make the server be deployable on a server
  * User handling
  * Repository handling
* Dont let workflows go to blocked when I use abort once -> Is never recontinued when I send a new message.
