package git

// ActionStep captures one user-visible Git command and its result.
type ActionStep struct {
	Label    string
	Command  string
	Stdout   string
	Stderr   string
	ExitCode int
	Err      error
}

type ActionRecorder func(ActionStep)

type InstrumentedRepository interface {
	Repository
	SetActionRecorder(ActionRecorder)
}
