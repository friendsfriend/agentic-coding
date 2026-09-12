package docker

import "testing"

func TestPreferredContainerInfoPrefersRunningOverExited(t *testing.T) {
	current := Info{Status: "exited", ContainerID: "old"}
	candidate := Info{Status: "running", ContainerID: "new"}
	got := preferredContainerInfo(current, candidate)
	if got.ContainerID != "new" {
		t.Fatalf("expected running container to win, got %#v", got)
	}
}

func TestPreferredContainerInfoKeepsRunningOverExited(t *testing.T) {
	current := Info{Status: "running", ContainerID: "new"}
	candidate := Info{Status: "exited", ContainerID: "old"}
	got := preferredContainerInfo(current, candidate)
	if got.ContainerID != "new" {
		t.Fatalf("expected running container to stay selected, got %#v", got)
	}
}

func TestContainerNameMatchesDockerAndPodmanComposeNames(t *testing.T) {
	cases := []struct {
		name  string
		ident string
		base  string
	}{
		{name: "/postgres-1", ident: "postgres", base: "postgres"},
		{name: "/postgres_1", ident: "postgres", base: "postgres"},
		{name: "/devenv-postgres-1", ident: "postgres", base: "postgres"},
		{name: "/devenv_postgres_1", ident: "postgres", base: "postgres"},
		{name: "devenv_mailpit_1", ident: "mailpit", base: "mailpit"},
		{name: "compose_bhvr-site_1", ident: "bhvr-site", base: ""},
	}
	for _, tc := range cases {
		if !ContainerNameMatches(tc.name, tc.ident, tc.base) {
			t.Fatalf("ContainerNameMatches(%q, %q, %q) = false", tc.name, tc.ident, tc.base)
		}
	}
}
