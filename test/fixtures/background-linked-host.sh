#!/bin/sh
# Use the exact selected Pi with a fullscreen PTY; no user resources are loaded.
export PI_OFFLINE=1
exec node "$PI_WEB_SEARCH_TEST_CLI" --tui-mode fullscreen "$@"
