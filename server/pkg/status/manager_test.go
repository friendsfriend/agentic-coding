package status

import "testing"

func TestStartOperationTreatsStoppedAsTerminal(t *testing.T) {
	manager := NewManager()
	update := manager.StartOperation("infra", OpStop)
	update("stopped")

	got := manager.GetStatus("infra")
	if got == nil {
		t.Fatal("expected operation status")
	}
	if got.StatusType != StatusCompleted {
		t.Fatalf("status=%q, want %q", got.StatusType, StatusCompleted)
	}
}
