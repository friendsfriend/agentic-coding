package resources

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTargetIdentityIncludesProvider(t *testing.T) {
	identity := RegistryTarget{Kind: TargetKindAppRun, App: "api", Runtime: ActionRuntimeDocker, Profile: "dev", Provider: ContainerProviderPodman}.Identity()
	if got, want := identity.String(), "app-run/api/docker/dev/podman"; got != want {
		t.Fatalf("identity=%q want=%q", got, want)
	}
	var ref DependencyRef
	if err := json.Unmarshal([]byte(`{"infra":"redis","runtime":"docker","profile":"local","provider":"podman"}`), &ref); err != nil {
		t.Fatal(err)
	}
	if ref.Provider != ContainerProviderPodman {
		t.Fatalf("provider=%q", ref.Provider)
	}
}

func TestTargetRegistryResolveStartPlan(t *testing.T) {
	t.Parallel()

	target := func(id string, requires ...DependencyRef) RegistryTarget {
		return RegistryTarget{ID: id, Kind: TargetKindAppRun, Requires: requires}
	}
	infra := func(id string, running bool) RegistryTarget {
		return RegistryTarget{ID: InfraTargetID(id), Kind: TargetKindInfra, Infra: id, Running: running}
	}

	t.Run("nested deps shared deps and already running", func(t *testing.T) {
		t.Parallel()
		backendID := AppRunTargetID("backend", ActionRuntimeSystemShell, "dev")
		frontendID := AppRunTargetID("frontend", ActionRuntimeSystemShell, "dev")
		workerID := AppRunTargetID("worker", ActionRuntimeDocker, "dev")
		registry := NewTargetRegistry([]RegistryTarget{
			infra("postgres", false),
			infra("redis", true),
			target(backendID, DependencyRef{Infra: "postgres"}),
			target(workerID, DependencyRef{Infra: "postgres"}, DependencyRef{Infra: "redis"}),
			target(frontendID,
				DependencyRef{App: "backend", Runtime: string(ActionRuntimeSystemShell), Profile: "dev"},
				DependencyRef{App: "worker", Runtime: string(ActionRuntimeDocker), Profile: "dev"},
			),
		})
		plan, err := registry.ResolveStartPlan(frontendID)
		if err != nil {
			t.Fatalf("ResolveStartPlan error = %v", err)
		}
		var ids []string
		for _, item := range plan {
			ids = append(ids, item.ID)
		}
		want := []string{InfraTargetID("postgres"), backendID, workerID, frontendID}
		if strings.Join(ids, ",") != strings.Join(want, ",") {
			t.Fatalf("plan = %#v, want %#v", ids, want)
		}
	})

	t.Run("provider-qualified dependency", func(t *testing.T) {
		t.Parallel()
		apiID := AppRuntimeTargetID("api", ActionRuntimeDocker, "dev", ContainerProviderPodman)
		redisID := InfraRuntimeProviderTargetID("redis", "docker", "local", ContainerProviderPodman)
		registry := NewTargetRegistry([]RegistryTarget{
			{ID: redisID, Kind: TargetKindInfra, Infra: "redis", Runtime: ActionRuntimeDocker, Profile: "local", Provider: ContainerProviderPodman},
			{ID: apiID, Kind: TargetKindAppRun, App: "api", Runtime: ActionRuntimeDocker, Profile: "dev", Provider: ContainerProviderPodman, Requires: []DependencyRef{{Infra: "redis", Runtime: "docker", Profile: "local", Provider: ContainerProviderPodman}}},
		})
		plan, err := registry.ResolveStartPlan(apiID)
		if err != nil {
			t.Fatal(err)
		}
		if len(plan) != 2 || plan[0].ID != redisID || plan[1].ID != apiID {
			t.Fatalf("plan=%#v", plan)
		}
	})

	t.Run("ambiguous provider requires selector", func(t *testing.T) {
		t.Parallel()
		registry := NewTargetRegistry([]RegistryTarget{
			{ID: InfraRuntimeProviderTargetID("redis", "docker", "local", ContainerProviderDocker), Kind: TargetKindInfra, Infra: "redis", Runtime: ActionRuntimeDocker, Profile: "local", Provider: ContainerProviderDocker},
			{ID: InfraRuntimeProviderTargetID("redis", "docker", "local", ContainerProviderPodman), Kind: TargetKindInfra, Infra: "redis", Runtime: ActionRuntimeDocker, Profile: "local", Provider: ContainerProviderPodman},
		})
		if _, err := registry.ResolveRef(DependencyRef{Infra: "redis", Runtime: "docker", Profile: "local"}); err == nil || !strings.Contains(err.Error(), "unknown infrastructure target") {
			t.Fatalf("err=%v", err)
		}
	})

	t.Run("missing dependency", func(t *testing.T) {
		t.Parallel()
		frontendID := AppRunTargetID("frontend", ActionRuntimeSystemShell, "dev")
		registry := NewTargetRegistry([]RegistryTarget{
			target(frontendID, DependencyRef{App: "missing", Runtime: string(ActionRuntimeShell), Profile: "dev"}),
		})
		_, err := registry.ResolveStartPlan(frontendID)
		if err == nil || !strings.Contains(err.Error(), "unknown app run target") {
			t.Fatalf("err = %v, want unknown app", err)
		}
	})

	t.Run("cycle chain", func(t *testing.T) {
		t.Parallel()
		aID := AppRunTargetID("a", ActionRuntimeShell, "dev")
		bID := AppRunTargetID("b", ActionRuntimeShell, "dev")
		registry := NewTargetRegistry([]RegistryTarget{
			target(aID, DependencyRef{App: "b", Runtime: string(ActionRuntimeShell), Profile: "dev"}),
			target(bID, DependencyRef{App: "a", Runtime: string(ActionRuntimeShell), Profile: "dev"}),
		})
		_, err := registry.ResolveStartPlan(aID)
		if err == nil || !strings.Contains(err.Error(), aID+" -> "+bID+" -> "+aID) {
			t.Fatalf("err = %v, want cycle chain", err)
		}
	})

	t.Run("missing runtime and profile", func(t *testing.T) {
		t.Parallel()
		registry := NewTargetRegistry([]RegistryTarget{})
		if _, err := registry.ResolveRef(DependencyRef{App: "api", Profile: "dev"}); err == nil || !strings.Contains(err.Error(), "requires runtime") {
			t.Fatalf("runtime err = %v", err)
		}
		if _, err := registry.ResolveRef(DependencyRef{App: "api", Runtime: string(ActionRuntimeDocker)}); err == nil || !strings.Contains(err.Error(), "requires profile") {
			t.Fatalf("profile err = %v", err)
		}
	})

	infraRuntime := func(id, runtime, profile string, running bool) RegistryTarget {
		return RegistryTarget{ID: InfraRuntimeTargetID(id, runtime, profile), Kind: TargetKindInfra, Infra: id, Running: running}
	}

	t.Run("kubernetes app and infrastructure dependencies", func(t *testing.T) {
		t.Parallel()
		backendID := AppRunTargetID("backend", ActionRuntimeKubernetes, "local")
		frontendID := AppRunTargetID("frontend", ActionRuntimeKubernetes, "local")
		postgresID := InfraRuntimeTargetID("postgres", "kubernetes", "local")
		registry := NewTargetRegistry([]RegistryTarget{
			infraRuntime("postgres", "kubernetes", "local", false),
			target(backendID),
			target(frontendID,
				DependencyRef{App: "backend", Runtime: string(ActionRuntimeKubernetes), Profile: "local"},
				DependencyRef{Infra: "postgres", Runtime: "kubernetes", Profile: "local"},
			),
		})
		plan, err := registry.ResolveStartPlan(frontendID)
		if err != nil {
			t.Fatalf("ResolveStartPlan error = %v", err)
		}
		ids := []string{}
		for _, item := range plan {
			ids = append(ids, item.ID)
		}
		want := []string{backendID, postgresID, frontendID}
		if strings.Join(ids, ",") != strings.Join(want, ",") {
			t.Fatalf("plan = %#v want %#v", ids, want)
		}
	})

	t.Run("bare infrastructure remains supported", func(t *testing.T) {
		t.Parallel()
		id := AppRunTargetID("api", ActionRuntimeDocker, "dev")
		registry := NewTargetRegistry([]RegistryTarget{infra("redis", false), target(id, DependencyRef{Infra: "redis"})})
		plan, err := registry.ResolveStartPlan(id)
		if err != nil {
			t.Fatalf("ResolveStartPlan error = %v", err)
		}
		if plan[0].ID != InfraTargetID("redis") {
			t.Fatalf("plan = %#v", plan)
		}
	})

	t.Run("missing kubernetes infrastructure dependency", func(t *testing.T) {
		t.Parallel()
		registry := NewTargetRegistry([]RegistryTarget{})
		_, err := registry.ResolveRef(DependencyRef{Infra: "postgres", Runtime: "kubernetes", Profile: "local"})
		if err == nil || !strings.Contains(err.Error(), "unknown infrastructure target") {
			t.Fatalf("err = %v", err)
		}
	})
}
