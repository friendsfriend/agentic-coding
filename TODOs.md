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
* Findings in the developer review:
    * Should show which reviewer marked the issue. 
    * Also it doesnt show a recommendation for a solution. I want it to have two parts: What is the issue? How can it be solved?


UI Rework / Devenv union: 
* Introduce log that logs all toast notifications and error modal contents
* Rework settings for model presets
    * Make proper ui instead of popup
    * Remove scope option
* Build proper provider settings ui for github and gitlab git providers
    * No proper ui has been built yet
* Dont show wiki frontmatter by default. Remove it from the markdown view and only make it show on pressing f. then show only the frontmatter in separate popup
* Render one line of space between paragraphs in wiki markdown view (not frontmatter)
* Also mark the comment if it is on the same line as the selected line
* Status updates in dash dont arrive
* the double q and ctrl + c still doesnt work in dash mode
* Introduce phase based telemetry grouping (tree view)
