#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/sync-upstream.sh [--push]

Fetch origin and upstream, then merge upstream/main into the local main branch.
Use --push to publish the merged result to origin/main after a successful merge.
EOF
}

push_after_merge=false
case "${1:-}" in
  "") ;;
  --push) push_after_merge=true ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before syncing." >&2
  exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Switch to the main branch before syncing." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Missing origin remote (the personal fork)." >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "Missing upstream remote (the original project)." >&2
  exit 1
fi

git fetch origin main
git fetch upstream main

# Incorporate changes that may have been pushed to the personal fork elsewhere.
git merge --no-edit origin/main

# Keep personal commits and merge the original project's new commits around them.
git merge --no-edit upstream/main

if [[ "$push_after_merge" == true ]]; then
  git push origin main
else
  echo "Upstream sync completed locally. Review it, then run: git push origin main"
fi
