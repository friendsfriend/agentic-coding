//go:build windows

package operations

import (
	"os/exec"
)

func setProcessGroup(cmd *exec.Cmd) {
	// Process groups are not supported on Windows. os/exec does not create or
	// assign a Windows Job Object during Start, so child processes inherit the
	// parent's job/group and their child trees cannot be reliably terminated.
	// Full containment would require an explicit Job Object with
	// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
}

// killProcessGroup can only terminate the group leader on Windows because
// setProcessGroup is a no-op; see the comment there.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
