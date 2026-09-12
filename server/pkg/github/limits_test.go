package github

import "testing"

func TestClampProviderLimit(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int
	}{
		{name: "zero", in: 0, want: defaultProviderLimit},
		{name: "negative", in: -1, want: defaultProviderLimit},
		{name: "valid", in: 25, want: 25},
		{name: "max", in: maxProviderLimit, want: maxProviderLimit},
		{name: "clamped", in: 500, want: maxProviderLimit},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := clampProviderLimit(tt.in); got != tt.want {
				t.Fatalf("clampProviderLimit(%d) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}
