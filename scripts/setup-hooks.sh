#!/bin/sh
#
# Point this clone at the committed hooks in .githooks/.
#
# `core.hooksPath` is local git configuration and is not carried by a clone, so
# every fresh checkout needs this once. Without it, .githooks/ is inert: git
# keeps looking in .git/hooks, where nothing is committed.
#
#   sh scripts/setup-hooks.sh
#
# Idempotent, and safe to re-run after changing hooks.

set -e

root=$(git rev-parse --show-toplevel)
cd "$root"

git config core.hooksPath .githooks

# Git only runs a hook it considers executable. On Windows the executable bit is
# advisory, but on Linux and macOS a checkout without it means the hook silently
# never fires, which is worse than an error.
chmod +x .githooks/* 2>/dev/null || true

echo "hooks: core.hooksPath is now $(git config --get core.hooksPath)"
echo "hooks: installed $(ls .githooks | tr '\n' ' ')"
echo "hooks: the test suite now runs before every push (SKIP_TESTS=1 to bypass)"
