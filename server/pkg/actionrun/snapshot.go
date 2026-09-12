package actionrun

import "github.com/friendsfriend/devenv/pkg/actiondef"

// DefinitionSnapshot removes executable configuration and protected defaults while preserving history chrome.
func DefinitionSnapshot(definition actiondef.Action) actiondef.Action {
	snapshot := actiondef.NewAction(definition)
	for i := range snapshot.InputDefinitions {
		if snapshot.InputDefinitions[i].Visibility == actiondef.VisibilitySecret || snapshot.InputDefinitions[i].Visibility == actiondef.VisibilityEphemeral {
			snapshot.InputDefinitions[i].Default = nil
		}
	}
	snapshot.RootStep = snapshotStep(snapshot.RootStep)
	return snapshot
}
func snapshotStep(step actiondef.Step) actiondef.Step {
	step.Configuration = nil
	step.InputPorts = visiblePorts(step.InputPorts)
	step.OutputPorts = visiblePorts(step.OutputPorts)
	for i := range step.ChildSteps {
		step.ChildSteps[i] = snapshotStep(step.ChildSteps[i])
	}
	return step
}
func visiblePorts(ports []actiondef.PortDefinition) []actiondef.PortDefinition {
	out := make([]actiondef.PortDefinition, 0, len(ports))
	for _, port := range ports {
		if port.Visibility != actiondef.VisibilitySecret && port.Visibility != actiondef.VisibilityEphemeral {
			out = append(out, port)
		}
	}
	return out
}
