Not for agents. This is only for humans.

Fixes: 

Big ones:
* Agent steered version of the workflow. Basically an orchestrator version of the workflow.
* subagent system for workers
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.

Small ones: 
* (Maybe) Give all agents their own tab. Multitab spawning always has issues for some reason
* Improve agent steering based on recent runs (observability first)
* Dependency upgrades

I want to try out a new workflow idea. 
I want this to be a separate workflow based on the openspec standard workflow. 
I want to use the jev 1.13 model via opencode go for classification of problems.
The Jev model should be used to determine the complexity of the plan (openspec artifacts as input, model should decide which worker model should be used (add 4 options to the existing presets for easy, medium, hard, critical). Jev should only classify into these 4 categories.)
For now I only want to do this for the openspec workflow.
This should allow a certain flexibility to the workflow and a reduced set of presets should be required for the user
I want this to run before the worker is spawned.
