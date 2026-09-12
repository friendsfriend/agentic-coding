package status

import (
	"strings"
	"sync"
	"time"

	"github.com/friendsfriend/devenv/pkg/logging"
)

// AppManager provides app display name resolution.
type AppManager interface {
	// GetDisplayName returns the display name for an app or service given its ident.
	GetDisplayName(ident string) string
}

// OperationType represents the type of operation
type OperationType string

const (
	OpBuild    OperationType = "build"
	OpTest     OperationType = "test"
	OpRun      OperationType = "run"
	OpStart    OperationType = "start"
	OpStop     OperationType = "stop"
	OpCheckout OperationType = "checkout"
	OpPush     OperationType = "push"
	OpPull     OperationType = "pull"
	OpFetch    OperationType = "fetch"
	OpScript   OperationType = "script"
)

// StatusType represents the nature of a status
type StatusType string

const (
	StatusPending   StatusType = "pending"
	StatusActive    StatusType = "active"
	StatusCompleted StatusType = "completed"
	StatusFailed    StatusType = "failed"
)

// AppStatus represents the current status of an app operation
type AppStatus struct {
	AppIdent   string
	Operation  OperationType
	StatusType StatusType
	Message    string
	Timestamp  time.Time
	AutoClear  bool
	ClearAfter time.Duration
}

// Manager manages centralized status updates for all operations.
type Manager interface {
	AddListener(listener Listener)
	RemoveListener(listener Listener)
	SetStatus(appIdent string, operation OperationType, statusType StatusType, message string)
	GetStatus(appIdent string) *AppStatus
	GetAllStatuses() map[string]*AppStatus
	ClearStatus(appIdent string)
	StartOperation(appIdent string, operation OperationType) func(string)
	GetFormattedStatus(appIdent string) string
	IsActiveOperation(appIdent string) bool
	GetOperationType(appIdent string) OperationType
}

type manager struct {
	mu         sync.RWMutex
	statuses   map[string]*AppStatus // appIdent -> current status
	timers     map[string]*time.Timer
	listeners  []Listener
	logger     logging.Logger
	appManager AppManager
}

// Listener receives status updates from the Manager.
type Listener interface {
	// OnStatusUpdate is called when a status changes.
	OnStatusUpdate(status *AppStatus)
	// OnStatusCleared is called when a status is cleared.
	OnStatusCleared(appIdent string)
}

// NewManager creates a new status manager.
func NewManager() Manager {
	return &manager{
		statuses:  make(map[string]*AppStatus),
		timers:    make(map[string]*time.Timer),
		listeners: make([]Listener, 0),
	}
}

// NewManagerWithLogger creates a new status manager with logging support.
func NewManagerWithLogger(logger logging.Logger, appManager AppManager) Manager {
	return &manager{
		statuses:   make(map[string]*AppStatus),
		timers:     make(map[string]*time.Timer),
		listeners:  make([]Listener, 0),
		logger:     logger,
		appManager: appManager,
	}
}

func (sm *manager) AddListener(listener Listener) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.listeners = append(sm.listeners, listener)
}

func (sm *manager) RemoveListener(listener Listener) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	for i, l := range sm.listeners {
		if l == listener {
			sm.listeners = append(sm.listeners[:i], sm.listeners[i+1:]...)
			break
		}
	}
}

func (sm *manager) SetStatus(appIdent string, operation OperationType, statusType StatusType, message string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	status := &AppStatus{
		AppIdent:   appIdent,
		Operation:  operation,
		StatusType: statusType,
		Message:    message,
		Timestamp:  time.Now(),
	}

	// Auto-clear completed/failed statuses after a delay
	if statusType == StatusCompleted || statusType == StatusFailed {
		status.AutoClear = true
		status.ClearAfter = 2 * time.Second
	}

	sm.statuses[appIdent] = status

	// Cancel any existing auto-clear timer for this app before scheduling a new one.
	// Without this, a previous timer could fire and wipe out the status we just set.
	if t, exists := sm.timers[appIdent]; exists {
		t.Stop()
		delete(sm.timers, appIdent)
	}

	// Notify listeners
	for _, listener := range sm.listeners {
		go listener.OnStatusUpdate(status)
	}

	// Schedule auto-clear using a cancelable timer (not a fire-and-forget goroutine)
	if status.AutoClear {
		sm.timers[appIdent] = time.AfterFunc(status.ClearAfter, func() {
			sm.ClearStatus(appIdent)
		})
	}
}

func (sm *manager) GetStatus(appIdent string) *AppStatus {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if status, exists := sm.statuses[appIdent]; exists {
		// Return a copy to avoid race conditions
		statusCopy := *status
		return &statusCopy
	}
	return nil
}

func (sm *manager) GetAllStatuses() map[string]*AppStatus {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	result := make(map[string]*AppStatus)
	for k, v := range sm.statuses {
		statusCopy := *v
		result[k] = &statusCopy
	}
	return result
}

func (sm *manager) ClearStatus(appIdent string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if _, exists := sm.statuses[appIdent]; exists {
		delete(sm.statuses, appIdent)

		// Clean up any pending timer entry
		if t, exists := sm.timers[appIdent]; exists {
			t.Stop()
			delete(sm.timers, appIdent)
		}

		// Notify listeners
		for _, listener := range sm.listeners {
			go listener.OnStatusCleared(appIdent)
		}
	}
}

func (sm *manager) StartOperation(appIdent string, operation OperationType) func(string) {
	// Immediately set the initial in-progress status
	initialMessage := sm.getInitialStatusMessage(operation)
	sm.SetStatus(appIdent, operation, StatusActive, initialMessage)

	return func(message string) {
		statusType := StatusActive

		// Determine status type based on message content
		lowerMessage := strings.ToLower(message)
		if message == "completed" || message == "start successful" || message == "build successful" ||
			strings.Contains(lowerMessage, "completed") ||
			strings.Contains(lowerMessage, "successful") ||
			strings.Contains(lowerMessage, "stopped") {
			statusType = StatusCompleted
		} else if isErrorMessage(message) || strings.Contains(strings.ToLower(message), "failed") {
			statusType = StatusFailed
		}

		sm.SetStatus(appIdent, operation, statusType, message)
	}
}

func (sm *manager) getInitialStatusMessage(operation OperationType) string {
	switch operation {
	case OpBuild:
		return "Building..."
	case OpTest:
		return "Testing..."
	case OpRun:
		return "Running..."
	case OpStart:
		return "Starting..."
	case OpStop:
		return "Stopping..."
	case OpCheckout:
		return "Checking out..."
	case OpPush:
		return "Pushing..."
	case OpPull:
		return "Pulling..."
	case OpFetch:
		return "Fetching..."
	case OpScript:
		return "Running script..."
	default:
		return "Processing..."
	}
}

// isErrorMessage determines if a message indicates an error
func isErrorMessage(message string) bool {
	return len(message) > 5 && (message[:6] == "Error:" || message[:6] == "error:")
}

func (sm *manager) GetFormattedStatus(appIdent string) string {
	status := sm.GetStatus(appIdent)
	if status == nil {
		return ""
	}
	return status.Message
}

func (sm *manager) IsActiveOperation(appIdent string) bool {
	status := sm.GetStatus(appIdent)
	return status != nil && status.StatusType == StatusActive
}

func (sm *manager) GetOperationType(appIdent string) OperationType {
	status := sm.GetStatus(appIdent)
	if status == nil {
		return ""
	}
	return status.Operation
}
