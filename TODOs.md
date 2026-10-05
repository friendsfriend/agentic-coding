Not for agents. This is only for humans.

Fixes: 

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
  * Improve jev quality by using better input
  * Compare local with hosted jev quality
* Implement instant workflow -> one agent without task, no workflow at all. Basically like spawning a random pi agent
* Implement workspace resume -> Should work with pi durable

* Implement specialized ui for developer question tool. Show context, questions and answers (possible and selected one) in a structured way. Like Context as rendered markdown one line space question1, answers1, one line of space, question2, answers2, ...)
* /Users/fabiankellner/Desktop/Screenshot\ 2026-10-05\ at\ 12.49.05.png -> Make expanded mode of codemode tool look like this. (Keep output and script in compact mode.). Make compact mode of codemode only show the first line λ 11 calls · 0.5s .The edit tool cant be expanded within the codemode tool view. Same for the read probably. Check this as well

