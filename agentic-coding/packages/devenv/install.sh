#!/usr/bin/env sh
# Install devenv binary to ~/.local/bin (local build)
set -e

INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="devenv"

# Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
x86_64 | amd64) ARCH="x64" ;;
aarch64 | arm64) ARCH="arm64" ;;
*)
	echo "Unsupported architecture: $ARCH"
	exit 1
	;;
esac

case "$OS" in
darwin | linux) ;;
*)
	echo "Unsupported OS: $OS"
	exit 1
	;;
esac

PLATFORM="${OS}-${ARCH}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY_PATH="${SCRIPT_DIR}/dist/tui/devenv-${PLATFORM}/bin/${BINARY_NAME}"

# A single Linux build may produce both glibc and musl variants. Prefer the
# native glibc binary, but fall back to musl if it is the only one present.
if [ ! -f "$BINARY_PATH" ] && [ "$OS" = "linux" ]; then
	MUSL_BINARY_PATH="${SCRIPT_DIR}/dist/tui/devenv-${PLATFORM}-musl/bin/${BINARY_NAME}"
	if [ -f "$MUSL_BINARY_PATH" ]; then
		BINARY_PATH="$MUSL_BINARY_PATH"
	fi
fi

if [ ! -f "$BINARY_PATH" ]; then
	echo "Binary not found for platform '${PLATFORM}': ${BINARY_PATH}"
	echo "Run 'bun run build:single' first to build the binary."
	exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$BINARY_PATH" "${INSTALL_DIR}/${BINARY_NAME}"
chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

# Re-sign on macOS to fix "invalid signature" after binary replacement
if [ "$OS" = "darwin" ] && command -v codesign >/dev/null 2>&1; then
	codesign --remove-signature "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null || true
	codesign -s - "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null || true
fi

echo "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

# Warn if install dir is not on PATH
case ":${PATH}:" in
*":${INSTALL_DIR}:"*) ;;
*)
	echo ""
	echo "Warning: ${INSTALL_DIR} is not in your PATH."
	echo "Add the following to your shell config (e.g. ~/.bashrc or ~/.zshrc):"
	echo ""
	echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
	;;
esac
