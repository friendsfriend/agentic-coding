package actiondef

// Action is a serializable immutable-by-convention definition. Constructors copy slices.
type Action struct {
	ActionID          ActionID          `json:"id"`
	Resource          ResourceRef       `json:"owner"`
	ActionType        ActionType        `json:"type"`
	ActionRuntime     Runtime           `json:"runtime"`
	DisplayLabel      string            `json:"label"`
	InputDefinitions  []InputDefinition `json:"inputs"`
	AvailabilityState Availability      `json:"availability"`
	RootStep          Step              `json:"root"`
}

func NewAction(a Action) Action {
	a.InputDefinitions = append([]InputDefinition(nil), a.InputDefinitions...)
	a.RootStep = NewStep(a.RootStep)
	return a
}
func (a Action) ID() ActionID       { return a.ActionID }
func (a Action) Owner() ResourceRef { return a.Resource }
func (a Action) Type() ActionType   { return a.ActionType }
func (a Action) Runtime() Runtime   { return a.ActionRuntime }
func (a Action) Label() string      { return a.DisplayLabel }
func (a Action) Inputs() []InputDefinition {
	return append([]InputDefinition(nil), a.InputDefinitions...)
}
func (a Action) Root() StepDefinition       { return NewStep(a.RootStep) }
func (a Action) Availability() Availability { return a.AvailabilityState }

type Step struct {
	StepID        StepDefinitionID `json:"id"`
	SharedKey     ExecutionKey     `json:"executionKey,omitempty"`
	StepType      StepKind         `json:"kind"`
	DisplayLabel  string           `json:"label"`
	ChildSteps    []Step           `json:"children,omitempty"`
	RunCondition  StepCondition    `json:"condition,omitempty"`
	OnFailure     FailurePolicy    `json:"failurePolicy,omitempty"`
	InputPorts    []PortDefinition `json:"consumes,omitempty"`
	OutputPorts   []PortDefinition `json:"produces,omitempty"`
	Handler       string           `json:"handler,omitempty"`
	Configuration map[string]any   `json:"configuration,omitempty"`
}

func NewStep(s Step) Step {
	s.ChildSteps = append([]Step(nil), s.ChildSteps...)
	for i := range s.ChildSteps {
		s.ChildSteps[i] = NewStep(s.ChildSteps[i])
	}
	s.InputPorts = append([]PortDefinition(nil), s.InputPorts...)
	s.OutputPorts = append([]PortDefinition(nil), s.OutputPorts...)
	if s.Configuration != nil {
		copy := make(map[string]any, len(s.Configuration))
		for k, v := range s.Configuration {
			copy[k] = v
		}
		s.Configuration = copy
	}
	return s
}
func (s Step) ID() StepDefinitionID       { return s.StepID }
func (s Step) ExecutionKey() ExecutionKey { return s.SharedKey }
func (s Step) Kind() StepKind             { return s.StepType }
func (s Step) Label() string              { return s.DisplayLabel }
func (s Step) Children() []StepDefinition {
	out := make([]StepDefinition, len(s.ChildSteps))
	for i := range s.ChildSteps {
		out[i] = NewStep(s.ChildSteps[i])
	}
	return out
}
func (s Step) Condition() StepCondition     { return s.RunCondition }
func (s Step) FailurePolicy() FailurePolicy { return s.OnFailure }
func (s Step) Consumes() []PortDefinition   { return append([]PortDefinition(nil), s.InputPorts...) }
func (s Step) Produces() []PortDefinition   { return append([]PortDefinition(nil), s.OutputPorts...) }
