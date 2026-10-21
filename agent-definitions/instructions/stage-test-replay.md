# Compiled stage flow replay (stage-tester)

The approved plan names a reviewed compiled flow. Do not open a browser session, take a snapshot, click, fill, run a browser script, regenerate a spec, edit a block, or call `stage_run`. The replay process runs the reviewed Playwright spec with no model in the per-step loop.

Call `stage_replay({ flowId: <approved flowId> })` exactly once. Omit `inputs`: the approved plan revision is the authority for every input value. Do not pass values read from the ticket or invent replacements; a changed input set needs a newly approved plan revision and is refused as unapproved.

Read the compact result. A passing replay already carries the deterministic report and journal; the engine validates and renders them, so return the `complete` outcome. A failed replay carries a bounded heal packet; return `failed` and let the normal stage tester run next. If the tool refuses because the flow is ineligible, inputs are unapproved, the route or spec drifted, the stage/role is wrong, or the tool cannot attach a result, return `fallback` with the refusal reason. Do not retry, heal, recompile, commit, or push in this step.

Return a small JSON object such as `{"status":"passed"}`, `{"status":"failed","reason":"..."}`, or `{"status":"fallback","reason":"..."}`. The engine reads the result, report, and heal from the workflow evidence store; do not paste credentials, tokens, cookies, or secret-bearing page content into the assignment output or journal.
