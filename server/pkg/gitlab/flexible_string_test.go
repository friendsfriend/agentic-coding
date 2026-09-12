package gitlab

import (
	"encoding/json"
	"testing"
)

func TestFlexibleString_UnmarshalJSON(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "plain string",
			input:    `"test output"`,
			expected: "test output",
		},
		{
			name:     "object with value field",
			input:    `{"value": "test output from object"}`,
			expected: "test output from object",
		},
		{
			name:     "empty string",
			input:    `""`,
			expected: "",
		},
		{
			name:     "null value",
			input:    `null`,
			expected: "",
		},
		{
			name:     "object with other fields",
			input:    `{"value": "important text", "other": "ignored"}`,
			expected: "important text",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var fs FlexibleString
			err := json.Unmarshal([]byte(tt.input), &fs)
			if err != nil {
				t.Fatalf("Unmarshal failed: %v", err)
			}
			if string(fs) != tt.expected {
				t.Errorf("Expected %q, got %q", tt.expected, string(fs))
			}
		})
	}
}

func TestFlexibleString_MarshalJSON(t *testing.T) {
	tests := []struct {
		name     string
		input    FlexibleString
		expected string
	}{
		{
			name:     "simple string",
			input:    FlexibleString("test output"),
			expected: `"test output"`,
		},
		{
			name:     "empty string",
			input:    FlexibleString(""),
			expected: `""`,
		},
		{
			name:     "string with special characters",
			input:    FlexibleString("test\noutput\t\"quoted\""),
			expected: `"test\noutput\t\"quoted\""`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.input)
			if err != nil {
				t.Fatalf("Marshal failed: %v", err)
			}
			if string(data) != tt.expected {
				t.Errorf("Expected %s, got %s", tt.expected, string(data))
			}
		})
	}
}

func TestTestCase_UnmarshalJSON(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantOut string
		wantErr string
	}{
		{
			name: "system_output as string",
			input: `{
				"name": "test1",
				"classname": "com.example.Test",
				"status": "passed",
				"execution_time": 1.5,
				"system_output": "plain string output"
			}`,
			wantOut: "plain string output",
			wantErr: "",
		},
		{
			name: "system_output as object",
			input: `{
				"name": "test2",
				"classname": "com.example.Test",
				"status": "failed",
				"execution_time": 2.3,
				"system_output": {"value": "object output"},
				"stack_trace": "error details"
			}`,
			wantOut: "object output",
			wantErr: "error details",
		},
		{
			name: "system_output missing",
			input: `{
				"name": "test3",
				"classname": "com.example.Test",
				"status": "passed",
				"execution_time": 0.5
			}`,
			wantOut: "",
			wantErr: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var tc TestCase
			err := json.Unmarshal([]byte(tt.input), &tc)
			if err != nil {
				t.Fatalf("Unmarshal failed: %v", err)
			}
			if string(tc.SystemOut) != tt.wantOut {
				t.Errorf("SystemOut: expected %q, got %q", tt.wantOut, string(tc.SystemOut))
			}
			if tc.SystemErr != tt.wantErr {
				t.Errorf("SystemErr: expected %q, got %q", tt.wantErr, tc.SystemErr)
			}
		})
	}
}
