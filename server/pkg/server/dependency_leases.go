package server

import (
	"fmt"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/state"
)

func (s *Server) leaseDependencies(definition actiondef.Action, runID string) {
	if s.services == nil || s.services.StateStore() == nil {
		return
	}
	var walk func(actiondef.Step)
	walk = func(step actiondef.Step) {
		if step.Configuration != nil && step.Configuration["lifecycle"] == "owned" && step.SharedKey != "" {
			lease := state.DependencyLease{TargetID: string(step.SharedKey), OwnerRunID: runID, OwnerApp: definition.Resource.ID, Lifecycle: "owned", UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
			_ = s.services.StateStore().SetDependencyLease(lease)
			s.leaseMu.Lock()
			s.dependencyLeases = append(s.dependencyLeases, lease)
			s.leaseMu.Unlock()
		}
		for _, child := range step.ChildSteps {
			walk(child)
		}
	}
	walk(definition.RootStep)
}
func (s *Server) releaseLeasesForOwner(ownerApp string) {
	if s.services == nil || s.services.StateStore() == nil {
		return
	}
	s.leaseMu.Lock()
	leases := s.dependencyLeases
	kept := leases[:0]
	var released []state.DependencyLease
	for _, lease := range leases {
		if lease.OwnerApp == ownerApp {
			_ = s.services.StateStore().DeleteDependencyLease(lease.TargetID, lease.OwnerRunID)
			released = append(released, lease)
		} else {
			kept = append(kept, lease)
		}
	}
	s.dependencyLeases = kept
	s.leaseMu.Unlock()
	for _, lease := range released {
		if !s.hasActiveLeaseForTarget(lease.TargetID) {
			s.stopOwnedTarget(lease.TargetID)
		}
	}
}
func (s *Server) hasActiveLeaseForTarget(targetID string) bool {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	for _, lease := range s.dependencyLeases {
		if lease.TargetID == targetID {
			return true
		}
	}
	return false
}
func (s *Server) stopOwnedTarget(targetID string) {
	parts := strings.Split(strings.TrimPrefix(targetID, "dependency/"), "/")
	if len(parts) < 2 || s.actionDefinitions == nil {
		return
	}
	resourceID, runtime := parts[0], parts[1]
	for _, definition := range s.actionDefinitions.Snapshot().ForResource(actiondef.ResourceRef{Kind: "infrastructure", ID: resourceID}) {
		if definition.ActionType == "stop" && string(definition.ActionRuntime) == runtime {
			_, _ = s.startEngineDefinition(definition, nil)
			return
		}
	}
}
func (s *Server) hasActiveDependents(targetID, excluding string) bool {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	for _, lease := range s.dependencyLeases {
		matches := lease.TargetID == targetID || lease.TargetID == "dependency/"+targetID || strings.HasPrefix(lease.TargetID, targetID+"/") || strings.HasPrefix(lease.TargetID, "dependency/"+targetID+"/")
		if matches && lease.OwnerApp != excluding {
			return true
		}
	}
	return false
}
func (s *Server) dependencyStopBlocked(definition actiondef.Action) error {
	if definition.ActionType != "stop" {
		return nil
	}
	target := string(definition.Resource.ID)
	if s.hasActiveDependents(target, definition.Resource.ID) {
		return fmt.Errorf("cannot stop %s: active dependent leases exist", target)
	}
	return nil
}
