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

* Implement a new notification system using the herdr notification system:
    * Every time a developer action is required in a workflow I want a notification to show with the workflow name and the phase. 
    * Once I click on the notification I want the dashboard of the workflow to be focused.
    * The default notifications of herdr that come when an agent finishes should be disabled as this is not a useful information if the user uses the workflow engine
