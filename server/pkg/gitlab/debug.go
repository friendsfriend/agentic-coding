package gitlab

import (
	"log"
	"os"
)

func debugLog(format string, args ...interface{}) {
	if os.Getenv("DEVENV_DEBUG") == "true" {
		log.Printf("[DEBUG] "+format, args...)
	}
}
