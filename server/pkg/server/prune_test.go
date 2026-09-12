package server

import (
	"slices"
	"testing"
)

func TestContainerPrunePreservesTaggedImages(t *testing.T) {
	args := containerPruneArgs()
	if slices.Contains(args, "--all") || slices.Contains(args, "-a") {
		t.Fatalf("prune args must preserve tagged application images: %v", args)
	}
	if len(args) < 2 || args[0] != "system" || args[1] != "prune" {
		t.Fatalf("unexpected prune command: %v", args)
	}
}
