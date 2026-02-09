#!/bin/bash

# Configuration
SESSION_NAME="dgx-spark-status"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9000

# Load nvm if available
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    source "$NVM_DIR/nvm.sh"
fi

# Check if tmux is installed
if ! command -v tmux &> /dev/null; then
    echo "Error: tmux is not installed. Please install it first:"
    echo "  sudo apt install tmux"
    exit 1
fi

# Function to check if port is in use
check_port() {
    if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Check if the session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Session '$SESSION_NAME' already exists. Reconnecting..."

    # Check if we're already inside a tmux session
    if [ -n "$TMUX" ]; then
        # Switch to the session if we're already in tmux
        tmux switch-client -t "$SESSION_NAME"
    else
        # Attach to the session, detaching other clients if necessary
        tmux attach-session -d -t "$SESSION_NAME"
    fi
else
    echo "Creating new tmux session '$SESSION_NAME'..."

    # Check if port is already in use
    if check_port; then
        echo "Warning: Port $PORT is already in use."
        echo "Please stop the process using port $PORT or the application may fail to start."
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    echo ""
    echo "Server starting on port $PORT..."
    echo "Access the application at: http://localhost:$PORT"
    echo "Press Ctrl+C to stop the server and exit"
    echo ""

    cd "$SCRIPT_DIR"

    # Start tmux session in the foreground, running the command directly
    # When npm exits (via Ctrl+C), the session automatically closes
    # Load nvm in the tmux session before running npm
    tmux new-session -s "$SESSION_NAME" "export NVM_DIR=\"$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && source \"\$NVM_DIR/nvm.sh\" && npm run dev"

    # Clean up after tmux exits
    echo ""
    echo "Server stopped."
fi
