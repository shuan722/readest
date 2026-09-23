#!/usr/bin/env bash

# Build the Apple Silicon DMG and always eject a leftover Readest image. The
# Tauri DMG helper normally ejects its temporary image, but a failed Finder or
# hdiutil step can leave /Volumes/Readest mounted and poison the next build.
set -u

readonly APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly READest_VOLUME="/Volumes/Readest"

cleanup_readest_volume() {
  if mount | awk '{print $3}' | grep -Fxq "${READest_VOLUME}"; then
    echo "Ejecting leftover ${READest_VOLUME} mount..."
    hdiutil detach "${READest_VOLUME}" >/dev/null 2>&1 || true
  fi
}

trap cleanup_readest_volume EXIT INT TERM

cd "${APP_DIR}"
export NEXT_PUBLIC_ANONYMOUS_BUILD=true
export NEXT_PUBLIC_DISABLE_UPDATER=true
export SENTRY_DSN=

# --features devtools keeps the WebView inspector available in the release
# build (right-click -> Inspect Element), so AI/chat failures can be read off
# the console instead of guessed at.
pnpm exec tauri build --bundles dmg --features devtools
