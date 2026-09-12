package server

import (
	"encoding/json"
	"testing"
)

func TestCompactActionHistoryJoinsConsecutiveOutputChunks(t *testing.T) {
	stored := []string{
		`{"type":"action.started","properties":{"run":{"id":"run"}},"timestamp":"2026-01-01T00:00:00Z"}`,
		`{"type":"action.step.output","properties":{"runId":"run","stepId":"step","commandId":"command","stream":"stdout","output":"first "},"timestamp":"2026-01-01T00:00:01Z"}`,
		`{"type":"action.step.output","properties":{"runId":"run","stepId":"step","commandId":"command","stream":"stdout","output":"second"},"timestamp":"2026-01-01T00:00:02Z"}`,
		`{"type":"action.step.output","properties":{"runId":"run","stepId":"step","commandId":"command","stream":"stderr","output":"warning"},"timestamp":"2026-01-01T00:00:03Z"}`,
		`{"type":"action.completed","properties":{"runId":"run","status":"completed"},"timestamp":"2026-01-01T00:00:04Z"}`,
	}

	compacted := compactActionHistory(stored)
	if len(compacted) != 4 {
		t.Fatalf("compacted events = %d, want 4", len(compacted))
	}
	var output actionHistoryEvent
	if err := json.Unmarshal(compacted[1], &output); err != nil {
		t.Fatal(err)
	}
	_, text, ok := actionOutput(output)
	if !ok || text != "first second" {
		t.Fatalf("compacted output = %q, ok = %v", text, ok)
	}
	if string(output.Timestamp) != `"2026-01-01T00:00:01Z"` {
		t.Fatalf("timestamp = %s", output.Timestamp)
	}
}
