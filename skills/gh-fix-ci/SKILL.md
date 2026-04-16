---
name: gh-fix-ci
description: Debug and fix failing GitHub PR checks that run in GitHub Actions. Use when a PR has failing CI checks — inspects check logs, summarizes failures, drafts a fix plan, and implements after approval. Triggers on "fix CI", "PR checks failing", "debug GitHub Actions", or failing pipeline investigation.
---

# Fix Failing PR CI Checks

## Overview

Locate failing PR checks, fetch GitHub Actions logs, summarize the failure, propose a fix, and implement after approval.

## Prerequisites

- `gh` CLI authenticated (`gh auth status` — needs repo + workflow scopes)
- Python 3 available

## Workflow

### 1) Inspect failing checks

Use the bundled script:

```bash
python3 ~/openclaw/skills/gh-fix-ci/scripts/inspect_pr_checks.py --repo "." --pr "<number-or-url>"
```

Add `--json` for machine-friendly output. Options:

- `--max-lines 200` — max log lines to capture
- `--context 40` — lines of context around failures

### 2) Manual fallback (if script fails)

```bash
gh pr checks <pr> --json name,state,bucket,link,startedAt,completedAt,workflow
gh run view <run_id> --log
```

### 3) Scope

- **GitHub Actions only.** If `detailsUrl` points to an external provider (Buildkite, etc.), report the URL only — don't attempt to debug it.

### 4) Summarize for the team

Provide: failing check name, run URL, concise log snippet. Call out missing logs explicitly.

### 5) Plan and fix

- Draft a fix plan and request approval before implementing
- After changes, re-run tests and `gh pr checks` to confirm

## Notes

- The script exits non-zero when failures remain (useful for automation)
- For rate limit issues, re-authenticate with `gh auth login`
