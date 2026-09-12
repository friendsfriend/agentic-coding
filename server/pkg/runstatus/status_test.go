package runstatus

import "testing"

func TestSelectUsesStatePriorityNotRuntimePriority(t *testing.T) {
	if got := Select([]Candidate{{Source: "docker", Status: "stopped"}, {Source: "kubernetes", Status: "running (1/1 pods)"}}); got != "running (1/1 pods)" {
		t.Fatalf("status=%q", got)
	}
	if got := Select([]Candidate{{Source: "kubernetes", Status: "failed (0/1 pods)"}, {Source: "podman", Status: "running"}}); got != "running" {
		t.Fatalf("status=%q", got)
	}
	if got := Select([]Candidate{{Source: "docker", Status: "not found"}, {Source: "kubernetes", Status: "starting (0/1 pods)"}}); got != "starting (0/1 pods)" {
		t.Fatalf("status=%q", got)
	}
}

func TestSelectAggregatesEqualHighestStates(t *testing.T) {
	if got := Select([]Candidate{{Source: "docker", Status: "running"}, {Source: "kubernetes", Status: "running (1/1 pods)"}}); got != "running (2 targets)" {
		t.Fatalf("status=%q", got)
	}
}

func TestSelectStatusSeparatesStateAndDetail(t *testing.T) {
	got := SelectStatus([]Candidate{{Source: "kubernetes", Status: "starting (1/2 pods)"}})
	if got.State != StateStarting || got.Detail != "1/2 pods" || got.String() != "starting (1/2 pods)" {
		t.Fatalf("status=%#v", got)
	}

	got = SelectStatus(nil)
	if got.State != StateStopped || got.Detail != "" {
		t.Fatalf("empty status=%#v", got)
	}
}

func TestNormalizePreservesRecognizedProviderDetail(t *testing.T) {
	for _, test := range []struct {
		input  string
		state  RuntimeState
		detail string
	}{
		{input: "Up 2 minutes", state: StateRunning, detail: "2 minutes"},
		{input: "down (reason)", state: StateStopped, detail: "reason"},
		{input: "CrashLoopBackOff (restart)", state: StateFailed, detail: "LoopBackOff (restart)"},
	} {
		got := Normalize(test.input)
		if got.State != test.state || got.Detail != test.detail {
			t.Errorf("Normalize(%q)=%#v, want state=%q detail=%q", test.input, got, test.state, test.detail)
		}
	}
}
