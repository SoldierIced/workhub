#!/usr/bin/env bash
# Build Workhub 2 and install it in /Applications (replacing any previous copy of Workhub 2).
# The bundle is named WORKHUB_BUNDLE_NAME (default "Workhub", so Spotlight and Launchpad open it as
# "Workhub"). It refuses to replace a bundle at that path that is not Workhub 2 (for example
# Workhub 1, bundle id com.nehuenfortes.workhub).
#
# WORKHUB_KEEP_RUNNING=1 swaps the bundle without quitting a running copy, which keeps its
# sessions; the new version starts the next time the app is opened.
# --dry-run prints the steps and changes nothing.
set -euo pipefail

dry_run=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    -h | --help) echo "Usage: scripts/install-mac.sh [--dry-run]   (WORKHUB_KEEP_RUNNING=1 swaps the bundle without quitting)"; exit 0 ;;
    *) echo "Unknown argument: $arg (usage: install-mac.sh [--dry-run])" >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
app_name="$(node "$root/scripts/brand.mjs" productName)"
bundle_name="${WORKHUB_BUNDLE_NAME:-Workhub}"
target="/Applications/$bundle_name.app"
app_id="$(node "$root/scripts/brand.mjs" appId 2>/dev/null || true)"
built="$root/dist/mac-arm64/$app_name.app"
keep_running="${WORKHUB_KEEP_RUNNING:-}"

# Refuse to ever operate on Workhub 1's bundle, whatever the brand says.
[[ "$app_name" != "Workhub" ]] || { echo "install-mac: productName is 'Workhub', that is Workhub 1's app; refusing" >&2; exit 1; }
if [[ -d "$target" ]]; then
  existing_id="$(defaults read "$target/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  if [[ "$existing_id" == "com.nehuenfortes.workhub" || ( -n "$app_id" && -n "$existing_id" && "$existing_id" != "$app_id" ) ]]; then
    echo "install-mac: $target is another app ($existing_id); refusing to replace it" >&2
    exit 1
  fi
fi

if $dry_run; then
  echo "dry run: nothing is built, quit or installed"
  echo "1. build: npm run dist:mac -> $built"
  if [[ "$keep_running" == 1 ]]; then
    echo "2. WORKHUB_KEEP_RUNNING=1: copy to $target.new, move the old bundle aside, move the new one in, delete the old (no quit)"
  else
    echo "2. quit only \"$app_name\" (osascript), remove $target, copy $built there"
  fi
  echo "3. refresh Launch Services for $target"
  echo "4. reopen \"$app_name\" if it was running and was quit"
  exit 0
fi

(cd "$root" && npm run dist:mac)
[[ -d "$built" ]] || { echo "install-mac: $built was not built" >&2; exit 1; }

# The running copy has to quit to be replaced (its sessions end; they can be resumed). It is
# opened again afterwards so an install never leaves the user without the app.
was_running=false
if pgrep -f "$target/Contents/MacOS/$app_name" >/dev/null; then was_running=true; fi
if [[ "$keep_running" == 1 ]]; then
  rm -rf "$target.new" "$target.old"
  cp -R "$built" "$target.new"
  mv "$target" "$target.old" 2>/dev/null || true
  mv "$target.new" "$target"
  rm -rf "$target.old"
  was_running=false
else
  if $was_running; then osascript -e "quit app \"$target\"" >/dev/null 2>&1 || true; fi
  sleep 1
  rm -rf "$target"
  cp -R "$built" "$target"
fi
# Refresh Launch Services so Finder, Spotlight and the Dock pick up the new icon and name.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target"
if $was_running; then open "$target"; fi
echo "$target"
