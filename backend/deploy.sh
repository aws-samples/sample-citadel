#!/bin/bash
set -euo pipefail

echo "⚠️  backend/deploy.sh is deprecated — forwarding to the root deploy.sh" >&2
exec "$(dirname "$0")/../deploy.sh" "$@"
