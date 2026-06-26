#!/usr/bin/env bash
# One-command demo runner. Loads RPC (with your private key) from .demo-env so the key never appears
# on screen, then runs the full on-chain cycle (init -> bet -> fraud-revert -> settle-by-proof -> claim).
set -a; [ -f "$(dirname "$0")/.demo-env" ] && . "$(dirname "$0")/.demo-env"; set +a
exec node "$(dirname "$0")/predictday_settlement/e2e.mjs"
