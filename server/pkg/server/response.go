package server

import (
	"encoding/json"
	"log"
	"net/http"
)

// ErrorResponse represents a standardized error response
type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	Code    int    `json:"code"`
}

// SuccessResponse represents a standardized success response
type SuccessResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Message string      `json:"message,omitempty"`
}

// respondJSON writes a JSON response with the given status code
func respondJSON(w http.ResponseWriter, data interface{}, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("[ERROR] Failed to encode JSON response: %v", err)
	}
}

// respondError writes a standardized error response
func respondError(w http.ResponseWriter, err error, statusCode int) {
	log.Printf("[ERROR] HTTP %d: %v", statusCode, err)

	errorResponse := ErrorResponse{
		Error:   http.StatusText(statusCode),
		Message: err.Error(),
		Code:    statusCode,
	}

	respondJSON(w, errorResponse, statusCode)
}

// respondErrorMessage writes a standardized error response with a string message
func respondErrorMessage(w http.ResponseWriter, message string, statusCode int) {
	log.Printf("[ERROR] HTTP %d: %s", statusCode, message)

	errorResponse := ErrorResponse{
		Error:   http.StatusText(statusCode),
		Message: message,
		Code:    statusCode,
	}

	respondJSON(w, errorResponse, statusCode)
}

// respondSuccess writes a standardized success response
func respondSuccess(w http.ResponseWriter, data interface{}, message string) {
	successResponse := SuccessResponse{
		Success: true,
		Data:    data,
		Message: message,
	}

	respondJSON(w, successResponse, http.StatusOK)
}

// respondMethodNotAllowed writes a 405 Method Not Allowed response
func respondMethodNotAllowed(w http.ResponseWriter) {
	respondErrorMessage(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// respondBadRequest writes a 400 Bad Request response
func respondBadRequest(w http.ResponseWriter, message string) {
	respondErrorMessage(w, message, http.StatusBadRequest)
}

// respondNotFound writes a 404 Not Found response
func respondNotFound(w http.ResponseWriter, message string) {
	respondErrorMessage(w, message, http.StatusNotFound)
}

// respondInternalError writes a 500 Internal Server Error response
func respondInternalError(w http.ResponseWriter, err error) {
	respondError(w, err, http.StatusInternalServerError)
}

// respondServiceUnavailable writes a 503 Service Unavailable response
func respondServiceUnavailable(w http.ResponseWriter, message string) {
	respondErrorMessage(w, message, http.StatusServiceUnavailable)
}
