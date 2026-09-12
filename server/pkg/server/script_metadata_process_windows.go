//go:build windows

package server

import "os/exec"

func configureMetadataCommand(cmd *exec.Cmd) {}

func killMetadataProcess(cmd *exec.Cmd) {}
