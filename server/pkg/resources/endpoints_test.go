package resources

import "testing"

func TestValidateEndpointProviderCompatibility(t *testing.T) {
	producer := ActionTarget{Runtime: ActionRuntimeDocker, Provider: ContainerProviderPodman, Exports: []EndpointExport{{Name: "db", Protocol: "tcp", Port: 5432, Strategy: "compose-service"}}}
	consumer := ActionTarget{Runtime: ActionRuntimeDocker, Provider: ContainerProviderDocker}
	if err := ValidateEndpointProviderCompatibility(producer, consumer); err == nil {
		t.Fatal("expected provider network error")
	}
}

func TestValidateEndpointContracts(t *testing.T) {
	if err := ValidateEndpointContracts([]ActionTarget{{ID: "db", Exports: []EndpointExport{{Name: "database", Protocol: "tcp", Port: 5432, Strategy: "kubernetes-service", Resource: "postgres"}}}}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateEndpointContracts([]ActionTarget{{ID: "a", Exports: []EndpointExport{{Name: "x", Protocol: "tcp", Port: 1, Strategy: "port-forward", LocalPort: 3000}}}, {ID: "b", Exports: []EndpointExport{{Name: "y", Protocol: "tcp", Port: 2, Strategy: "port-forward", LocalPort: 3000}}}}); err == nil {
		t.Fatal("expected port conflict")
	}
	if err := ValidateEndpointContracts([]ActionTarget{{ID: "a", Exports: []EndpointExport{{Name: "x", Protocol: "tcp", Port: 1, Strategy: "unsupported"}}}}); err == nil {
		t.Fatal("expected strategy error")
	}
}
