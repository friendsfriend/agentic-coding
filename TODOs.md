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


UI Rework: 
* Rework settings for model presets
    * Make proper ui instead of popup
    * Remove scope option
* Build proper provider settings ui for github and gitlab git providers
    * No proper ui has been built yet
* Rework repair modal. Remove ids. Only desired phase is relevant for user



Plan for developer question UI (Demo Iwan):

I want to improve the UI and the mechanism for the developer question tooling. 
Currently the context is usually not enough for me to understand the issue.
I often feel not in the loop enough to answer the questions confidently.

Therefore I want to introduce a more detailed and context driven developer question tool. 
The tool should require the following inputs:
* Who asks the question
* List of:
    * Question ident (short title for the tab in case of multiple questions)
    * Question (Just the question part)
    * Context description (Markdown text with information about the background)
    * Selectable options (title, recommendation y/n, detailed description in markdown format)

The UI then should show a modal containing 1 tab for each question (navigatable with tab and shift + tab -> backwards)
The question should then be displayed as a scrollable markdown rendered context box on the top
question in the middle
selectable options with recommendation marker in the bottom. (d shows the markdown information for the option in a separate markdown modal)
alt + enter to confirm finished inputs


