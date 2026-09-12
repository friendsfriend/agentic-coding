package server

import "testing"

func TestParsePage(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want int
	}{
		{name: "empty", in: "", want: defaultPage},
		{name: "invalid", in: "nope", want: defaultPage},
		{name: "zero", in: "0", want: defaultPage},
		{name: "negative", in: "-1", want: defaultPage},
		{name: "valid", in: "3", want: 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parsePage(tt.in); got != tt.want {
				t.Fatalf("parsePage(%q) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

func TestParsePerPage(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want int
	}{
		{name: "empty", in: "", want: defaultPerPage},
		{name: "invalid", in: "nope", want: defaultPerPage},
		{name: "zero", in: "0", want: defaultPerPage},
		{name: "negative", in: "-1", want: defaultPerPage},
		{name: "valid", in: "25", want: 25},
		{name: "clamped", in: "500", want: maxPerPage},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parsePerPage(tt.in); got != tt.want {
				t.Fatalf("parsePerPage(%q) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}
