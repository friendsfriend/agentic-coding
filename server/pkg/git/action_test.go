package git

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestRunGitCommandRecordsRealOutputAndExitCode(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("git", "init", "-q", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	var got ActionStep
	called := false
	gr := &gitRepository{}
	gr.SetActionRecorder(func(step ActionStep) { got, called = step, true })
	stdout, stderr, err := gr.runGitCommand(dir, "status", "--short")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !called || got.Command == "" || got.ExitCode != 0 {
		t.Fatalf("recorded step = %#v, called=%v", got, called)
	}
	if got.Stdout != stdout || got.Stderr != stderr {
		t.Fatalf("recorded output differs: stdout=%q/%q stderr=%q/%q", got.Stdout, stdout, got.Stderr, stderr)
	}

	_, _, err = gr.runGitCommand(dir, "show-ref", "--verify", "refs/heads/missing")
	if err == nil || got.ExitCode != 128 || !strings.Contains(got.Command, "show-ref") || got.Err == nil {
		t.Fatalf("failed command not captured: %#v err=%v", got, err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
}
