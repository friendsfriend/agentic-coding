package cmd

import (
	"log"

	"github.com/friendsfriend/devenv/pkg/server"
	"github.com/spf13/cobra"
)

var (
	serverPort     int
	serverInstance string
)

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Start HTTP API server for OpenTUI frontend",
	Long:  "Start HTTP API server that provides REST endpoints and Server-Sent Events for the OpenTUI-based frontend",
	Run: func(cmd *cobra.Command, args []string) {
		srv := server.NewServerWithInstance(serverPort, serverInstance)
		log.Printf("Starting server on port %d", serverPort)
		if err := srv.Start(); err != nil {
			log.Fatal(err)
		}
	},
}

func init() {
	rootCmd.AddCommand(serverCmd)
	serverCmd.Flags().IntVarP(&serverPort, "port", "p", 4050, "Port to run the server on")
	serverCmd.Flags().StringVar(&serverInstance, "instance", "", "Launch identity reported by /api/health (default: random)")
}
