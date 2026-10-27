#!/usr/bin/env bash
# Package a Workhub 2 release from this machine: build the installers for this OS, write a SHA-256
# file per artifact and the release notes, all under dist/. With --publish it also creates the
# GitHub release (tag v<version>) and uploads the files.
#
#   scripts/release.sh             build, checksums and release notes
#   scripts/release.sh --publish   the same, then `gh release create` on the repository
#   scripts/release.sh --dry-run   print every step and the release notes; build and write nothing
#
# <version> is the root package.json's. The release is a pre-release while it has a suffix
# (2.0.0-alpha.1). CI (.github/workflows/release.yml) builds every OS when a v* tag is pushed and
# attaches the installers to a draft release; use this script for a macOS-only release from here.
# The macOS build is signed with an Apple Development identity or ad hoc, never notarized.
set -euo pipefail

die() {
  echo "release: $*" >&2
  exit 1
}

publish=false
dry_run=false
for arg in "$@"; do
  case "$arg" in
    --publish) publish=true ;;
    --dry-run) dry_run=true ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg (usage: release.sh [--publish] [--dry-run])" >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
repo="${WORKHUB_RELEASE_REPO:-$(node "$root/scripts/brand.mjs" repo)}"
product="$(node "$root/scripts/brand.mjs" productName)"
version="$(node -p "require('$root/package.json').version")"
app_version="$(node -p "require('$root/packages/app/package.json').version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "root package.json version is not semver: $version"
[[ "$version" == "$app_version" ]] || die "root version $version and packages/app version $app_version differ"

tag="v$version"
dist="$root/dist"
notes="$dist/release-notes-$version.md"
prerelease=()
[[ "$version" == *-* ]] && prerelease=(--prerelease)

case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) os=win ;;
esac

build_cmd=(npm run dist -w . --if-present)
build_cmd=(npm run dist)

release_notes() {
  local previous
  previous="$(git -C "$root" describe --tags --abbrev=0 --match 'v*' --exclude "$tag" 2>/dev/null || true)"
  cat <<NOTES
## $product $version

Pre-release builds are unsigned: the first launch needs one extra step.

- **macOS (Apple Silicon):** download the \`.dmg\` (or the \`.zip\`), move **$product** to Applications. macOS blocks the first launch because the app is not notarized: open it once, then System Settings > Privacy & Security > **Open Anyway**. Or run \`xattr -dr com.apple.quarantine "/Applications/$product.app"\`.
- **Windows (x64):** run the \`.exe\` installer. SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**.
- **Linux (x64):** \`chmod +x\` the \`.AppImage\` and run it, or install the \`.deb\`.

Each artifact has a \`.sha256\` file next to it. Full guide: https://github.com/$repo#install
NOTES
  if [[ -n "$previous" ]]; then
    printf '\n### Changes since %s\n\n' "$previous"
    git -C "$root" log --no-merges --pretty='- %s' "$previous..HEAD"
  fi
}

print_cmd() {
  printf '  '
  printf '%q ' "$@"
  printf '\n'
}

# The files a build leaves in dist/ that belong to the release.
collect_assets() {
  find "$dist" -maxdepth 1 -type f \( -name "*-$version-*" -o -name 'latest*.yml' \) ! -name '*.sha256' ! -name '*.md' | sort
}

publish_cmd_preview=(gh release create "$tag" "<artifacts, .sha256 files and latest*.yml from dist/>" --repo "$repo" --target "<HEAD>" --title "$product $version" --notes-file "$notes" ${prerelease[@]+"${prerelease[@]}"})

if $dry_run; then
  echo "dry run: nothing is built, written or published"
  echo "version $version, tag $tag, repository $repo, os $os"
  echo "1. build the installers for this OS into $dist:"
  print_cmd "${build_cmd[@]}"
  echo "2. write a .sha256 file next to each artifact (shasum -a 256)"
  echo "3. write the release notes: $notes"
  if $publish; then
    echo "4. publish (checks first: gh signed in, clean tree, HEAD pushed, $tag not taken):"
    print_cmd "${publish_cmd_preview[@]}"
  else
    echo "4. publish: skipped, pass --publish to create the GitHub release"
  fi
  echo
  echo "--- release notes ---"
  release_notes
  exit 0
fi

if $publish; then
  # Checked before the build, so a release never fails halfway for a reason known up front.
  command -v gh >/dev/null 2>&1 || die "gh is not installed"
  gh auth status >/dev/null 2>&1 || die "gh is not signed in (run gh auth login)"
  [[ -z "$(git -C "$root" status --porcelain)" ]] || die "the working tree has uncommitted changes: commit them so the tag matches the build"
  [[ -n "$(git -C "$root" branch -r --contains HEAD)" ]] || die "HEAD is not on the remote yet: push it first"
  if git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then die "tag $tag already exists"; fi
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then die "release $tag already exists on $repo"; fi
fi

rm -rf "$dist"
(cd "$root" && "${build_cmd[@]}")

assets=()
while IFS= read -r f; do assets+=("$f"); done < <(collect_assets)
[[ ${#assets[@]} -gt 0 ]] || die "the build left no artifacts in $dist"
sums=()
for f in "${assets[@]}"; do
  case "$f" in
    *.yml) continue ;;
  esac
  # Written from inside dist/ so the file checks with `shasum -a 256 -c` next to the artifact.
  (cd "$dist" && shasum -a 256 "$(basename "$f")" > "$f.sha256")
  sums+=("$f.sha256")
done
release_notes > "$notes"

echo "artifacts:"
printf '  %s\n' "${assets[@]}" "${sums[@]}"
echo "notes: $notes"

if $publish; then
  gh release create "$tag" "${assets[@]}" "${sums[@]}" --repo "$repo" --target "$(git -C "$root" rev-parse HEAD)" \
    --title "$product $version" --notes-file "$notes" ${prerelease[@]+"${prerelease[@]}"}
  echo "published $tag on $repo"
else
  echo "not published: review the notes, then run scripts/release.sh --publish"
fi
