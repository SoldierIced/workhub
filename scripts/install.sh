#!/usr/bin/env bash
# Installs (or updates) Workhub 2 on macOS (Apple silicon) from the latest published GitHub release.
# Run it in Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/SoldierIced/workhub/main/scripts/install.sh | bash
#
# It downloads the app, checks it against its .sha256 and puts it in /Applications as
# WORKHUB_BUNDLE_NAME (default "Workhub", like scripts/install-mac.sh). A running copy keeps
# working; the new version starts the next time the app is opened. Building from source is
# scripts/install-mac.sh instead.
set -euo pipefail

repo="SoldierIced/workhub"
bundle_name="${WORKHUB_BUNDLE_NAME:-Workhub}"
target="/Applications/$bundle_name.app"
app_id="io.github.soldiericed.workhub2"

fail() { echo "install: $*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || fail "this script installs the macOS app; on Windows run scripts/install.ps1, on Linux download the AppImage or .deb from https://github.com/$repo/releases"
[[ "$(uname -m)" == arm64 ]] || fail "only Apple silicon (arm64) builds are published so far"

# Every release also carries its installers under names without the version, so this link always
# fetches the latest one (see .github/workflows/release.yml).
url="https://github.com/$repo/releases/latest/download/Workhub-2-mac-arm64.zip"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/$(basename "$url")"
echo "Downloading the latest Workhub 2..."
curl -fL --progress-bar -o "$zip" "$url" || fail "could not download $url (no published release yet?); see https://github.com/$repo/releases"
if curl -fsSL -o "$zip.sha256" "$url.sha256"; then
  want="$(awk '{print $1}' "$zip.sha256")"
  got="$(shasum -a 256 "$zip" | awk '{print $1}')"
  [[ "$got" == "$want" ]] || fail "the download does not match its checksum; nothing was installed"
  echo "Checksum OK."
fi

ditto -x -k "$zip" "$tmp/app"
built="$(find "$tmp/app" -maxdepth 1 -name '*.app' | head -1)"
[[ -n "$built" ]] || fail "the download holds no app"
[[ "$(defaults read "$built/Contents/Info" CFBundleIdentifier)" == "$app_id" ]] || fail "the download is not Workhub 2"

# Never replace another app (for example Workhub 1) that happens to have the same name.
if [[ -d "$target" ]]; then
  existing="$(defaults read "$target/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  [[ -z "$existing" || "$existing" == "$app_id" ]] || fail "$target is another app ($existing); set WORKHUB_BUNDLE_NAME to install under another name"
fi

echo "Installing to $target..."
rm -rf "$target.new" "$target.old"
ditto "$built" "$target.new"
# The app is not notarized: drop the quarantine flag so macOS opens it without a warning.
xattr -dr com.apple.quarantine "$target.new" 2>/dev/null || true
if [[ -d "$target" ]]; then mv "$target" "$target.old"; fi
mv "$target.new" "$target"
rm -rf "$target.old"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target" 2>/dev/null || true

if pgrep -f "$target/Contents/MacOS/" >/dev/null; then
  echo "Done. Workhub 2 is running: the new version starts the next time you open it."
else
  echo "Done. Opening Workhub 2."
  open "$target"
fi
