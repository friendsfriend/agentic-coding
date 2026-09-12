package actionrun

import (
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type Status string

const (
	StatusPending   Status = "pending"
	StatusActive    Status = "active"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
)

type Command struct {
	ID         string     `json:"id"`
	Command    string     `json:"command"`
	Status     Status     `json:"status"`
	Stdout     string     `json:"stdout,omitempty"`
	Stderr     string     `json:"stderr,omitempty"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Error      string     `json:"error,omitempty"`
	ExitCode   *int       `json:"exitCode,omitempty"`
}

type Step struct {
	ID              string                     `json:"id"`
	Label           string                     `json:"label"`
	Status          Status                     `json:"status"`
	ParentID        string                     `json:"parentId,omitempty"`
	Depth           int                        `json:"depth,omitempty"`
	Collapsed       bool                       `json:"collapsed,omitempty"`
	Commands        []Command                  `json:"commands"`
	StartedAt       *time.Time                 `json:"startedAt,omitempty"`
	FinishedAt      *time.Time                 `json:"finishedAt,omitempty"`
	Error           string                     `json:"error,omitempty"`
	DefinitionID    actiondef.StepDefinitionID `json:"definitionId,omitempty"`
	ExecutionKey    actiondef.ExecutionKey     `json:"executionKey,omitempty"`
	Outcome         actiondef.StepOutcome      `json:"outcome,omitempty"`
	CanonicalID     actiondef.StepDefinitionID `json:"canonicalId,omitempty"`
	SharedReference bool                       `json:"sharedReference,omitempty"`
}

type Run struct {
	ID                 string                 `json:"id"`
	Title              string                 `json:"title"`
	AppIdent           string                 `json:"appIdent,omitempty"`
	Action             string                 `json:"action,omitempty"`
	Kind               string                 `json:"kind,omitempty"`
	Profile            string                 `json:"profile,omitempty"`
	TargetLabel        string                 `json:"targetLabel,omitempty"`
	Metadata           map[string]interface{} `json:"metadata,omitempty"`
	Status             Status                 `json:"status"`
	Steps              []Step                 `json:"steps"`
	StartedAt          *time.Time             `json:"startedAt,omitempty"`
	FinishedAt         *time.Time             `json:"finishedAt,omitempty"`
	RegistryVersion    uint64                 `json:"registryVersion,omitempty"`
	DefinitionSnapshot *actiondef.Action      `json:"definitionSnapshot,omitempty"`
}

type StartedEvent struct {
	Run Run `json:"run"`
}
type StepStartedEvent struct {
	RunID   string `json:"runId"`
	StepID  string `json:"stepId"`
	Command string `json:"command"`
	Index   int    `json:"index"`
}
type StepOutputEvent struct {
	RunID  string `json:"runId"`
	StepID string `json:"stepId"`
	Output string `json:"output"`
	Stream string `json:"stream"`
}
type StepHealthEvent struct {
	RunID  string `json:"runId"`
	StepID string `json:"stepId"`
	Status string `json:"status"`
}
type StepCompletedEvent struct {
	RunID  string `json:"runId"`
	StepID string `json:"stepId"`
}
type StepFailedEvent struct {
	RunID  string `json:"runId"`
	StepID string `json:"stepId"`
	Error  string `json:"error"`
}
type CompletedEvent struct {
	RunID  string `json:"runId"`
	Status Status `json:"status"`
}
