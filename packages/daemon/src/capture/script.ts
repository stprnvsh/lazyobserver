/**
 * The hook script Claude Code runs on every captured event.
 *
 * Design constraints (hard):
 *  - NEVER fail or slow a session: pure POSIX sh, no node startup, `exit 0`
 *    on every path, 5s timeout configured on the hook entry.
 *  - Concurrent-safe: each event lands in its OWN spool file via mktemp,
 *    written to a dot-temp then atomically renamed — the daemon can never
 *    read a half-written event, and parallel hooks never interleave.
 *  - Envelope: appends one `_lzo` JSON line carrying surface hints
 *    (TERM_PROGRAM / bundle id) and a timestamp.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# lazyobserver capture hook — appends one event to the spool. Never fails the session.
d="\${LAZYOBSERVER_HOME:-$HOME/.lazyobserver}/spool"
[ -d "$d" ] || exit 0
t=$(mktemp "$d/.tmp.XXXXXXXXXX" 2>/dev/null) || exit 0
{
  cat
  printf '\\n{"_lzo":{"term":"%s","bundle":"%s","task":"%s","ts":%s000}}\\n' "\${TERM_PROGRAM:-}" "\${__CFBundleIdentifier:-}" "\${LAZYOBSERVER_TASK_ID:-}" "$(date +%s)"
} > "$t" 2>/dev/null
b=\${t##*/.tmp.}
mv "$t" "$d/evt-$b.json" 2>/dev/null || rm -f "$t" 2>/dev/null
exit 0
`;

/**
 * Marker present in every hook command we install — how we find "ours".
 * Covers both the capture hook (lazyobserver-hook.sh) and the SessionStart
 * brief (lazyobserver-brief.sh), so uninstall removes exactly our entries.
 */
export const HOOK_MARKER = ".lazyobserver/bin/lazyobserver-";
