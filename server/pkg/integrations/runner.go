package integrations

import (
	"context"
	"fmt"

	"github.com/friendsfriend/devenv/pkg/actionexec"
)

// ForwardingRunner is the temporary bridge for the still-Go action owner: a
// `git` command step is executed by the Bun Git capability, every other command
// runs locally as before.
//
// Only the execution moves. The Go action owner keeps emitting the command
// events and recording the run/step/command tree, which is why the runner
// replays the real output through the same `output` callback a local run uses.
type ForwardingRunner struct {
	Client *Client
	// Fallback runs anything that is not a forwarded Git command. It must be
	// set; an action run never silently drops a command.
	Fallback actionexec.CommandRunner
}

// SupportsForwarding reports whether a command step should cross the adapter.
// Only `git` is forwarded, and only when the step names a working directory:
// without one the argv has no checkout to run in.
func SupportsForwarding(spec actionexec.CommandSpec) bool {
	return spec.Name == "git" && spec.Dir != ""
}

func (r ForwardingRunner) Run(ctx context.Context, spec actionexec.CommandSpec, output func(string, string)) actionexec.CommandResult {
	if r.Client == nil || !SupportsForwarding(spec) {
		return r.fallback().Run(ctx, spec, output)
	}
	outcome, err := r.Client.RunGitCommand(ctx, GitCommandRequest{
		RunID:     spec.RunID,
		StepID:    spec.StepID,
		CommandID: spec.CommandID,
		Directory: spec.Dir,
		Args:      spec.Args,
	})
	if err != nil {
		// A failed bridge must not look like a failed command: report the
		// transport failure so the run records why nothing was executed.
		return actionexec.CommandResult{ExitCode: -1, Err: fmt.Errorf("git command forwarding failed: %w", err)}
	}
	if output != nil {
		if outcome.Stdout != "" {
			output("stdout", outcome.Stdout)
		}
		if outcome.Stderr != "" {
			output("stderr", outcome.Stderr)
		}
	}
	result := actionexec.CommandResult{
		Stdout:   outcome.Stdout,
		Stderr:   outcome.Stderr,
		ExitCode: outcome.ExitCode,
	}
	if outcome.ExitCode != 0 {
		result.Err = fmt.Errorf("%s exited with code %d", outcome.Command, outcome.ExitCode)
	}
	return result
}

func (r ForwardingRunner) fallback() actionexec.CommandRunner {
	if r.Fallback != nil {
		return r.Fallback
	}
	return actionexec.OSCommandRunner{}
}
