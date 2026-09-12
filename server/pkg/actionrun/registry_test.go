package actionrun

import (
	"testing"
	"time"
)

func TestRegistryRejectsDuplicateAppActionAndCleansUp(t *testing.T) {
	r := NewRegistry()
	run := Run{ID: "r1", Status: StatusActive}
	if err := r.Start(run, "app", "build", []string{"db"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(Run{ID: "r2", Status: StatusActive}, "app", "build", nil); err == nil {
		t.Fatal("expected duplicate rejection")
	}
	r.Complete("r1", StatusCompleted)
	r.Cleanup(time.Now().Add(23 * time.Hour))
	if _, ok := r.Get("r1"); !ok {
		t.Fatal("run removed before 24-hour retention elapsed")
	}
	r.Cleanup(time.Now().Add(25 * time.Hour))
	if _, ok := r.Get("r1"); ok {
		t.Fatal("run retained after 24-hour retention elapsed")
	}
	if err := r.Start(Run{ID: "r2", Status: StatusActive}, "app", "build", nil); err != nil {
		t.Fatal(err)
	}
}

func TestRegistryAllowsDifferentActionsAndApps(t *testing.T) {
	r := NewRegistry()
	if err := r.Start(Run{ID: "build", Status: StatusActive}, "app", "build", []string{"db"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(Run{ID: "test", Status: StatusActive}, "app", "test", []string{"db"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(Run{ID: "other", Status: StatusActive}, "other", "build", []string{"db"}); err != nil {
		t.Fatal(err)
	}
	if len(r.Active()) != 3 {
		t.Fatalf("expected 3 active runs")
	}
}
