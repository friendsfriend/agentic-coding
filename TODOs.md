Not for agents. This is only for humans.

* Fix question option for worker -> Planner / consolidator
* Fix minor ui stuff (Weird texts in new workflow modal)
* Review all workflows and test them out
* Implement subagent system for workers
* Implement Agent steered version of the workflow. Basically an orchestrator version of the workflow.
* Automatic wiki commit + push if in git repo.
* openspec panel shows all instead of only relevant changes / specs
* Fix runtime calculation for agents that take multiple turns

* Architecture improvements based on gpt 6 astra:
  * fix effect lease lifecycle (done)
  * unify worfklow startup context (done)
  * version workflow behavior pins (done)
  * version workflow migrations (done)
  * seperate workflow observation execution (done)
  * centralize step completion behavior
  * contsolidate-tui-primitives
  * split-dashboard-responsibilities
  * enforce-source-layer-boundaries

Effect switchover
 * Effect foundation, schemas, errors, agent conventions.
 * Transactional runtime migration.
 * Runner and adapter migration.
 * CLI/TUI cutover and legacy-code removal.

