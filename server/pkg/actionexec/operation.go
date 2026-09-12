package actionexec

import "github.com/friendsfriend/devenv/pkg/actiondef"

type OperationFunc func(actiondef.StepContext, actiondef.StepDefinition) actiondef.StepResult
type OperationHandler struct{ Run OperationFunc }

func (OperationHandler) Supports(kind actiondef.StepKind) bool {
	return kind == actiondef.StepKindOperation
}
func (h OperationHandler) Execute(ctx actiondef.StepContext, definition actiondef.StepDefinition) actiondef.StepResult {
	if h.Run == nil {
		return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
	}
	return h.Run(ctx, definition)
}
