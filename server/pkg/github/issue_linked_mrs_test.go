package github

import (
	"sort"
	"testing"
)

func TestParseClosingReferences(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		expected []int
	}{
		{
			name:     "closes #123",
			body:     "This PR closes #123",
			expected: []int{123},
		},
		{
			name:     "fixes #456",
			body:     "fixes #456",
			expected: []int{456},
		},
		{
			name:     "resolves #789",
			body:     "resolves #789",
			expected: []int{789},
		},
		{
			name:     "closed by #321",
			body:     "closed by #321",
			expected: []int{321},
		},
		{
			name:     "GH-42 shorthand",
			body:     "See GH-42 for details",
			expected: []int{42},
		},
		{
			name:     "Closes: #100 (with colon)",
			body:     "Closes: #100",
			expected: []int{100},
		},
		{
			name:     "multiple references",
			body:     "Closes #1, fixes #2, resolves #3",
			expected: []int{1, 2, 3},
		},
		{
			name:     "deduplication",
			body:     "Fixes #5. Also closes #5.",
			expected: []int{5},
		},
		{
			name:     "cross-repo reference",
			body:     "Depends on owner/repo#99",
			expected: []int{99},
		},
		{
			name:     "no references",
			body:     "This is a bug report with no PR references",
			expected: []int{},
		},
		{
			name:     "empty body",
			body:     "",
			expected: []int{},
		},
		{
			name:     "fix: #123",
			body:     "fix: #123",
			expected: []int{123},
		},
		{
			name:     "Fix #123 (capitalized)",
			body:     "Fix #123",
			expected: []int{123},
		},
		{
			name:     "Close #123",
			body:     "Close #123",
			expected: []int{123},
		},
		{
			name:     "closes issue #123",
			body:     "closes issue #123",
			expected: []int{123},
		},
		{
			name:     "bare #123 (cross-reference)",
			body:     "See #123 for details",
			expected: []int{123},
		},
		{
			name:     "related to #456",
			body:     "Related to #456",
			expected: []int{456},
		},
		{
			name:     "mixed: keyword + bare",
			body:     "Fixes #1. Also see #2.",
			expected: []int{1, 2},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseClosingReferences(tt.body)
			sort.Ints(got)
			sort.Ints(tt.expected)

			if len(got) != len(tt.expected) {
				t.Errorf("parseClosingReferences(%q) = %v, want %v", tt.body, got, tt.expected)
				return
			}
			for i := range got {
				if got[i] != tt.expected[i] {
					t.Errorf("parseClosingReferences(%q) = %v, want %v", tt.body, got, tt.expected)
					return
				}
			}
		})
	}
}
