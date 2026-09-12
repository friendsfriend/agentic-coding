//go:build !windows

package operations

import (
	"os/exec"
	"syscall"
)

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup signals the whole process group created by setProcessGroup
// so scripts' child processes (servers, watchers, port-forward helpers) do not
// outlive the parent. Falls back to killing only the leader if the group is
// unavailable.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		return cmd.Process.Kill()
	}
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}
