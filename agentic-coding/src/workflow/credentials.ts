import type { Subprocess } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CredentialPrompt = (prompt: string) => Promise<string>;

export interface AskpassShim {
  dir: string;
  shimPath: string;
  requestFifo: string;
  responseFifo: string;
}

// The askpass shim is invoked by ssh/git exactly when a credential is required
// (with SSH_ASKPASS_REQUIRE=force ssh always runs it). It relays the verbatim
// prompt text to the runner over the request FIFO, then blocks on the response
// FIFO for the answer. The timeout keeps a backgrounded/missing UI from hanging
// the running command forever: after it fires, the shim echoes an empty answer
// and ssh aborts with its original error.
const ASKPASS_SHIM = `#!/bin/sh
# agentic-coding askpass shim: relay an ssh/git credential prompt to the
# dashboard bridge over FIFOs and echo the entered answer back to the caller.
dir="\${AGENTIC_CODING_ASKPASS_DIR:?askpass dir required}"
prompt="\${1:-}"
printf '%s\\n' "$prompt" > "$dir/request.fifo" 2>/dev/null || exit 1
timeout="\${AGENTIC_CODING_ASKPASS_TIMEOUT:-120}"
if command -v timeout >/dev/null 2>&1; then
  answer="$(timeout "$timeout" cat "$dir/response.fifo" 2>/dev/null || true)"
elif command -v gtimeout >/dev/null 2>&1; then
  answer="$(gtimeout "$timeout" cat "$dir/response.fifo" 2>/dev/null || true)"
else
  # Neither GNU coreutils' timeout(1) nor macOS's gtimeout is guaranteed to be
  # on PATH. Without one of them, \`cat response.fifo\` blocks in open(2) until
  # a writer connects and can hang forever, wedging the whole workflow runner.
  # Enforce the same bound manually: read into a temp file in the background
  # and poll it from the foreground, explicitly killing the reader once the
  # deadline passes (a backgrounded \`sleep "$timeout"; kill ...\` companion
  # process is not reliable here: a non-interactive shell blocked in a
  # synchronous \`sleep\` does not act on a delivered SIGTERM until \`sleep\`
  # itself returns, so waiting on that companion can still block for the
  # full timeout).
  tmp="$dir/response.\$\$.tmp"
  cat "$dir/response.fifo" > "$tmp" 2>/dev/null &
  reader="$!"
  elapsed=0
  while kill -0 "$reader" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout" ]; then
      kill "$reader" 2>/dev/null
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$reader" 2>/dev/null
  answer="$(cat "$tmp" 2>/dev/null || true)"
  rm -f "$tmp"
fi
printf '%s' "$answer"
`;

function makeFifo(file: string): void {
  const result = Bun.spawnSync(['mkfifo', '-m', '600', file], { stderr: 'ignore' });
  if (result.exitCode !== 0) {
    try { if (fs.statSync(file).isFIFO()) return } catch { /* fall through to error */ }
    throw new Error(`mkfifo ${file} failed`);
  }
}

export function installAskpassShim(dir = path.join(os.tmpdir(), 'agentic-coding-askpass')): AskpassShim {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const processDir = fs.mkdtempSync(path.join(dir, `askpass-${process.pid}-`));
  fs.chmodSync(processDir, 0o700);
  const shim: AskpassShim = {
    dir: processDir,
    shimPath: path.join(processDir, 'askpass'),
    requestFifo: path.join(processDir, 'request.fifo'),
    responseFifo: path.join(processDir, 'response.fifo'),
  };
  fs.writeFileSync(shim.shimPath, ASKPASS_SHIM, { mode: 0o700 });
  makeFifo(shim.requestFifo);
  makeFifo(shim.responseFifo);
  return shim;
}

export function cleanupAskpassShim(shim: AskpassShim): void {
  try { fs.rmSync(shim.dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

/** Mask typed input unless the requested credential is a username. */
export function maskingFor(prompt: string): boolean {
  return !/username/i.test(prompt);
}

export function credentialFailureMessage(prompt: string): string {
  return `git requested a credential (${prompt.trim()}) but no interactive prompt is available. Unlock your SSH key (ssh-add) or run the workflow from the dashboard so the passphrase can be entered.`;
}

export interface RunGitWithCredentialsOptions {
  /** Resolves the user's answer for a requested credential; absent => fail fast. */
  prompt?: CredentialPrompt;
  /** Executable to run (defaults to `git`; overridable for tests). */
  executable?: string;
  /** Extra environment for the spawned command (merged over process env). */
  env?: Record<string, string>;
}

const ASKPASS_ENV: Record<string, string> = {
  SSH_ASKPASS_REQUIRE: 'force',
  LANG: 'C',
  LC_ALL: 'C',
  LC_MESSAGES: 'C',
};

export async function runGitWithCredentials(cwd: string, args: string[], options: RunGitWithCredentialsOptions = {}): Promise<string> {
  const shim = installAskpassShim();
  const env: Record<string, string> = {
    ...process.env,
    ...(options.env ?? {}),
    ...ASKPASS_ENV,
    SSH_ASKPASS: shim.shimPath,
    GIT_ASKPASS: shim.shimPath,
    AGENTIC_CODING_ASKPASS_DIR: shim.dir,
  };
  const proc = Bun.spawn([options.executable ?? 'git', '-C', cwd, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const readerHolder = { reader: undefined as Subprocess | undefined };
  try {
    while (proc.exitCode === null) {
      const promptText = await waitForRequest(proc, shim, readerHolder);
      if (promptText === undefined) break;
      if (!options.prompt) throw new Error(credentialFailureMessage(promptText));
      const answer = await promptForAnswer(options.prompt, promptText, proc);
      if (answer === undefined) break;
      await writeAnswer(shim, answer, proc.exitCode === null);
    }
    const exitCode = await proc.exited;
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `command exited ${exitCode}`);
    return stdout.trim();
  } finally {
    try { readerHolder.reader?.kill() } catch { /* already gone */ }
    // Fail-fast and abort paths leave the command blocked on the askpass shim;
    // kill it so the effect fails promptly instead of lingering until the shim
    // timeout.
    if (proc.exitCode === null) { try { proc.kill() } catch { /* already gone */ } }
    cleanupAskpassShim(shim);
  }
}

/**
 * Block until the askpass shim relays a prompt (a writer opened the request
 * FIFO) or the command exits without requesting anything. Returns the verbatim
 * prompt text, or undefined when the command finished with no request.
 */
async function waitForRequest(proc: Subprocess, shim: AskpassShim, holder: { reader?: Subprocess }): Promise<string | undefined> {
  const reader = Bun.spawn(['cat', shim.requestFifo], { stdout: 'pipe', stderr: 'ignore' });
  holder.reader = reader;
  const read = new Response(reader.stdout).text();
  const outcome = await Promise.race([read, proc.exited.then(() => undefined)]);
  if (outcome === undefined && reader.exitCode === null) { try { reader.kill() } catch { /* already gone */ } }
  return outcome === undefined ? undefined : outcome.replace(/\r?\n+$/, '');
}
async function promptForAnswer(prompt: CredentialPrompt, promptText: string, proc: Subprocess): Promise<string | undefined> {
  // The command may die while the answer is awaited (askpass timeout, remote
  // abort). Treat that like a cancel so the runner never hangs behind the UI.
  const answer = await Promise.race([
    prompt(promptText).then(value => value ?? ''),
    proc.exited.then(() => undefined),
  ]);
  return answer;
}

async function writeAnswer(shim: AskpassShim, answer: string, callerAlive: boolean): Promise<void> {
  // The shim blocks reading the response FIFO right after relaying its prompt;
  // opening for writing rendezvous with it. If the caller already died the shim
  // is gone too, so there is nothing to feed.
  if (!callerAlive) return;
  const fd = await fs.promises.open(shim.responseFifo, 'w');
  try { await fd.writeFile(answer, 'utf8') } finally { await fd.close() }
}
