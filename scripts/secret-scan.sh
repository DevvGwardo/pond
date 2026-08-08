#!/usr/bin/env sh
# Pre-commit secret guard. Pond is a public repo; this blocks the two ways a
# secret usually slips in — committing a secret-bearing FILE, or pasting a key
# INLINE. Pure POSIX sh, no dependencies (matches CONTRIBUTING's "no new deps").
# Bypassable with `git commit --no-verify`; CI gitleaks is the non-bypassable
# complement (see the launch-hardening tasks).
#
# Patterns are deliberately high-signal (provider prefixes, PEM headers, the
# known prod host IP) so package-lock integrity hashes and ordinary code don't
# false-positive. Generic "long hex/base64" is intentionally NOT scanned.

set -eu

self="scripts/secret-scan.sh"
fail=0

# --- 1. Secret-bearing FILES staged for commit (by path) ---
# Matches real env/credential/key files but NOT *.example templates.
staged_files=$(git diff --cached --name-only --diff-filter=AM)
bad_paths=$(printf '%s\n' "$staged_files" | grep -E \
  '(^|/)\.env(\.pond\.server|\.local|\.production)?$|(^|/)credentials\.json$|\.pem$|(^|/)id_(rsa|ed25519)$|keypair.*\.json$|(^|/)host-token$' \
  || true)
if [ -n "$bad_paths" ]; then
  echo "✖ secret-scan: refusing to commit secret-bearing file(s):" >&2
  printf '    %s\n' $bad_paths >&2
  echo "  These belong in .gitignore, not the repo. Use an *.example template instead." >&2
  fail=1
fi

# --- 2. Secret-looking CONTENT in the added lines ---
# Scan only added (+) lines of the staged diff, excluding this scanner file
# (which contains the patterns + prod IP it searches for).
added=$(git diff --cached -U0 --no-color -- . ":(exclude)$self" | grep -E '^\+' || true)
hits=$(printf '%s\n' "$added" | grep -nE \
  'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-ant-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|5\.78\.209\.49' \
  || true)
if [ -n "$hits" ]; then
  echo "✖ secret-scan: possible secret / prod host reference in staged changes:" >&2
  printf '%s\n' "$hits" | sed 's/^/    /' >&2
  echo "  Remove it, or if it's a false positive commit with: git commit --no-verify" >&2
  fail=1
fi

exit $fail
