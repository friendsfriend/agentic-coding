package server

import (
	"github.com/friendsfriend/devenv/pkg/state"
	"testing"
)

func TestOwnedDependencyProtectsActiveDependent(t *testing.T) {
	s := &Server{dependencyLeases: []state.DependencyLease{{TargetID: "dependency/redis/docker/local", OwnerRunID: "run-1", OwnerApp: "api", Lifecycle: "owned"}}}
	if !s.hasActiveDependents("redis", "other") {
		t.Fatal("expected active dependent")
	}
	if s.hasActiveDependents("redis", "api") {
		t.Fatal("owner should be excluded")
	}
}
