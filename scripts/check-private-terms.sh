#!/usr/bin/env bash
# Blocks commits and pushes that would publish private terms (employer names, internal ticket keys,
# home paths...). The terms are never in this repository: they live in a file of the developer's,
# one case-insensitive extended regex per line ('#' starts a comment):
#   $WORKHUB_PRIVATE_TERMS, else ~/.config/workhub/private-terms.txt
# Without that file every check passes, so the hooks cost nothing to contributors who don't need them.
#
#   check-private-terms.sh staged             the staged diff (pre-commit)
#   check-private-terms.sh message <file>     a commit message (commit-msg)
#   check-private-terms.sh range <from> <to>  the patches and messages of a commit range (pre-push)
#   check-private-terms.sh tree               every tracked file
set -euo pipefail

terms_file="${WORKHUB_PRIVATE_TERMS:-$HOME/.config/workhub/private-terms.txt}"
[[ -f "$terms_file" ]] || exit 0
pattern="$(grep -v -E '^[[:space:]]*(#|$)' "$terms_file" | paste -sd '|' -)"
[[ -n "$pattern" ]] || exit 0

# Prints only where a term is, never the matched line, so the terms don't end up in a terminal log.
report() {
  echo "Private terms found in $1. Remove them (see CONTRIBUTING.md, 'Keeping private data out')." >&2
  exit 1
}

case "${1:-}" in
  staged)
    found=""
    while IFS= read -r -d '' file; do
      # Added lines only, and the file's own path.
      if git diff --cached -U0 --no-color -- "$file" | grep '^+' | grep -v '^+++' | grep -q -i -E "$pattern" || grep -q -i -E "$pattern" <<<"$file"; then
        found+="  $file"$'\n'
      fi
    done < <(git diff --cached --name-only -z --diff-filter=ACMR)
    [[ -z "$found" ]] || report "the staged changes:
$found"
    ;;
  message)
    grep -v '^#' "$2" | grep -q -i -E "$pattern" && report "the commit message"
    ;;
  range)
    commits="$(git rev-list "$2..$3" 2>/dev/null || git rev-list "$3")"
    for c in $commits; do
      git show --format='%B' --no-color "$c" | grep -q -i -E "$pattern" && report "commit $(git log -1 --format='%h %s' "$c")"
    done
    ;;
  tree)
    files="$(git grep -l -i -E "$pattern" -- . || true)"
    [[ -z "$files" ]] || report "tracked files:
$(sed 's/^/  /' <<<"$files")"
    ;;
  *)
    echo "usage: $0 staged | message <file> | range <from> <to> | tree" >&2
    exit 2
    ;;
esac
exit 0
