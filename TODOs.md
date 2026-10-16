Not for agents. This is only for humans.

Fixes: 

Big ones:
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.
* Rework existing AI features using the workflow engine (ai summary for logs etc.)
* Introduce dependency upgrade and migration workflow

Small ones: 
* Implement compaction feature 
  * Compaction doenst trigger and settings cant be changed via ui...
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
* Multi Repository workflows for cross app testing

* Environment setup:
  * The worker agent for the env setup has no environment tools. That is not good. The agent should be able to list the available environments and test the created environment
  * The draft folder is an issue. It doenst allow to test the setup properly with the real deal. New concept is required
