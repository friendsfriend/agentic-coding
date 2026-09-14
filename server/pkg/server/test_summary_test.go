package server

import "testing"

// Pins the check-run summary extraction the GitHub test-summary route uses
// (`port-git-providers-and-ai-to-bun`, task 3.4). The Bun port asserts the same
// numbers, including the quirk that `"passed: 3 failed: 1"` counts 3 failed
// because the first pattern matches the digits in front of "failed".
func TestExtractTestCountPatterns(t *testing.T) {
	cases := []struct {
		text    string
		pattern string
		want    int
	}{
		{"12 passed, 2 failed, 1 skipped", `(\d+)\s*passed`, 12},
		{"12 passed, 2 failed, 1 skipped", `(\d+)\s*failed`, 2},
		{"12 passed, 2 failed, 1 skipped", `(\d+)\s*skipped`, 1},
		{"passed: 3 failed: 1", `(\d+)\s*passed`, 0},
		{"passed: 3 failed: 1", `passed[:\s]+(\d+)`, 3},
		{"passed: 3 failed: 1", `(\d+)\s*failed`, 3},
		{"5 tests", `(\d+)\s*tests?`, 5},
		{"no counts here", `(\d+)\s*passed`, 0},
	}
	for _, tc := range cases {
		if got := extractTestCount(tc.text, tc.pattern); got != tc.want {
			t.Errorf("extractTestCount(%q, %q) = %d, want %d", tc.text, tc.pattern, got, tc.want)
		}
	}
}
