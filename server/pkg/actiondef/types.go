package actiondef

import "context"

// Stable identifiers are configuration-derived and never include checkout paths or labels.
type (
	ActionID         string
	StepDefinitionID string
	ExecutionKey     string
	ValueKey         string
	ValueType        string
	RunID            string
)

type ResourceRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type ActionType string
type Runtime string
type StepKind string
type StepCondition string
type FailurePolicy string
type ValueScope string
type ValueVisibility string

const (
	StepKindComposite StepKind = "composite"
	StepKindCommand   StepKind = "command"
	StepKindProcess   StepKind = "process"
	StepKindReadiness StepKind = "readiness"
	StepKindOperation StepKind = "operation"
	StepKindCleanup   StepKind = "cleanup"

	ConditionAlways    StepCondition = "always"
	ConditionOnSuccess StepCondition = "on-success"
	ConditionOnFailure StepCondition = "on-failure"

	FailureStop      FailurePolicy = "stop"
	FailureContinue  FailurePolicy = "continue"
	FailureAlwaysRun FailurePolicy = "always-run"

	ScopeAction    ValueScope = "action"
	ScopeComposite ValueScope = "composite"
	ScopeStep      ValueScope = "step"

	VisibilityPublic    ValueVisibility = "public"
	VisibilityInternal  ValueVisibility = "internal"
	VisibilitySecret    ValueVisibility = "secret"
	VisibilityEphemeral ValueVisibility = "ephemeral"
)

type PortDefinition struct {
	Key        ValueKey        `json:"key"`
	Type       ValueType       `json:"type"`
	Scope      ValueScope      `json:"scope"`
	Visibility ValueVisibility `json:"visibility"`
	Required   bool            `json:"required,omitempty"`
}

type InputDefinition struct {
	PortDefinition
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
	Default     any    `json:"default,omitempty"`
}

type Availability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

type ActionDefinition interface {
	ID() ActionID
	Owner() ResourceRef
	Type() ActionType
	Runtime() Runtime
	Label() string
	Inputs() []InputDefinition
	Root() StepDefinition
}

type StepDefinition interface {
	ID() StepDefinitionID
	ExecutionKey() ExecutionKey
	Kind() StepKind
	Label() string
	Children() []StepDefinition
	Condition() StepCondition
	FailurePolicy() FailurePolicy
	Consumes() []PortDefinition
	Produces() []PortDefinition
}

const (
	ValueTypeEndpoint ValueType = "endpoint"
)

type EndpointValue struct {
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
}

type Value struct {
	Type       ValueType
	Visibility ValueVisibility
	Data       any
}

type StepResult struct {
	Outcome  StepOutcome
	ExitCode *int
	Err      error
}

type StepOutcome string

const (
	OutcomeExecuted       StepOutcome = "executed"
	OutcomeAlreadyRunning StepOutcome = "already-running"
	OutcomeSkipped        StepOutcome = "skipped"
	OutcomeFailed         StepOutcome = "failed"
)

type CommandExecutor interface{}
type EventSink interface{}
type SecretResolver interface{}

type StepContext interface {
	Context() context.Context
	RunID() RunID
	StepID() StepDefinitionID
	Require(ValueKey) (Value, error)
	Set(ValueKey, Value) error
	Executor() CommandExecutor
	Events() EventSink
	Secrets() SecretResolver
}

type StepHandler interface {
	Supports(StepKind) bool
	Execute(StepContext, StepDefinition) StepResult
}

type ExecutionCoordinator interface {
	Acquire(context.Context, ExecutionKey, []string) (ExecutionLease, error)
}

type ExecutionLease interface {
	Owner() bool
	Outcome() StepOutcome
	Wait(context.Context) (StepResult, error)
	Release(StepResult)
}
