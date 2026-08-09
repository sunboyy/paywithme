#!/usr/bin/env python3
"""PreToolUse guard: refuse destructive Bash commands that reach outside the repo.

Written after a subagent ran `rm -f tests/../../*.sql`, which resolved to the
directory ABOVE this repo and would have deleted unrelated files.

Deliberately narrow. It does NOT block reading, listing, or running things
outside the repo — the autonomous build legitimately shells out to pnpm, drives
a Postgres container, and reads spec slices from the session scratchpad. It
blocks only a *destructive verb* whose *target path* resolves outside the
allowed roots, which is the class of mistake that actually loses data.

Exit 0 always; the decision travels in the JSON on stdout. A crash here must
never wedge the session, so unexpected errors fall through to "allow".
"""

import json
import os
import re
import sys

# Roots a destructive command may touch.
ALLOWED_ROOTS = [
    os.path.realpath(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "/private/tmp",
    "/private/var/folders",
    "/tmp",
    "/var/folders",
]

# Commands that can destroy or relocate data.
DESTRUCTIVE = {
    "rm", "rmdir", "unlink", "shred", "truncate", "dd", "mv",
    "chown", "chgrp", "mkfs", "sfill",
}

# Splits a compound command into individually-judged segments.
SEGMENT_SPLIT = re.compile(r"(?:\|\||&&|[;|\n&])")

# Flags/option words that are never path targets.
FLAG = re.compile(r"^-")


def allowed(path: str) -> bool:
    real = os.path.realpath(path)
    for root in ALLOWED_ROOTS:
        root = os.path.realpath(root)
        if real == root or real.startswith(root + os.sep):
            return True
    return False


def candidate_paths(tokens, cwd):
    """Resolve the non-flag operands of a destructive command to absolute paths."""
    out = []
    for tok in tokens:
        tok = tok.strip().strip('"').strip("'")
        if not tok or FLAG.match(tok):
            continue
        # `if=`/`of=` operands (dd).
        if tok.startswith(("if=", "of=")):
            tok = tok.split("=", 1)[1]
        if tok.startswith("~"):
            tok = os.path.expanduser(tok)
        out.append(tok if os.path.isabs(tok) else os.path.join(cwd, tok))
    return out


def offending(command: str, cwd: str):
    """Return (path, segment) for the first destructive escape, else None."""
    for segment in SEGMENT_SPLIT.split(command):
        segment = segment.strip()
        if not segment:
            continue

        tokens = segment.split()
        # Step past sudo/env-style prefixes to find the real verb.
        i = 0
        while i < len(tokens) and (tokens[i] in ("sudo", "command", "nohup", "time") or "=" in tokens[i] and not tokens[i].startswith(("if=", "of="))):
            i += 1
        if i >= len(tokens):
            continue

        verb = os.path.basename(tokens[i])
        operands = tokens[i + 1:]

        # `find ... -delete` / `find ... -exec rm` is destructive at its search root.
        if verb == "find" and ("-delete" in operands or "-exec" in operands):
            for path in candidate_paths([t for t in operands if not t.startswith("-")][:1], cwd):
                if not allowed(path):
                    return path, segment
            continue

        if verb not in DESTRUCTIVE:
            # Still catch redirection into a file outside the repo.
            for match in re.finditer(r">>?\s*([^\s;|&]+)", segment):
                target = match.group(1)
                if target.startswith("/dev/"):
                    continue
                for path in candidate_paths([target], cwd):
                    if not allowed(path):
                        return path, segment
            continue

        for path in candidate_paths(operands, cwd):
            if not allowed(path):
                return path, segment

    return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    command = (payload.get("tool_input") or {}).get("command") or ""
    cwd = payload.get("cwd") or ALLOWED_ROOTS[0]

    try:
        hit = offending(command, cwd)
    except Exception:
        sys.exit(0)

    if hit:
        path, segment = hit
        reason = (
            f"Blocked: this command would modify or delete `{path}`, which is outside "
            f"the repository.\n\nSegment: `{segment}`\n\n"
            "Destructive commands (rm, mv, dd, truncate, chown, find -delete, "
            "output redirection) are restricted to the repo, /tmp and the session "
            "scratchpad. If you need a scratch file, put it under the scratchpad "
            "directory. Reading and running programs outside the repo is unaffected."
        )
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }))
    sys.exit(0)


if __name__ == "__main__":
    main()
