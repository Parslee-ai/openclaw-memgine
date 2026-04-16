---
name: gh-address-comments
description: Fetch and address review comments on an open GitHub PR. Use when asked to handle PR review feedback, fix review comments, or respond to CodeRabbit/reviewer suggestions. Triggers on "address PR comments", "fix review feedback", "handle PR reviews".
---

# Address PR Review Comments

## Overview

Find the open PR for the current branch, fetch all review comments and threads via GraphQL, summarize them, and apply fixes for selected comments.

## Prerequisites

- `gh` CLI authenticated (`gh auth status` — needs repo + workflow scopes)
- Python 3 available
- Current branch must have an associated open PR

## Workflow

### 1) Fetch all comments

```bash
cd <repo-dir>
python3 ~/openclaw/skills/gh-address-comments/scripts/fetch_comments.py
```

This uses `gh api graphql` to fetch:

- Top-level conversation comments
- Review comments (inline)
- Review threads with full context

### 2) Present to user/agent

- Number all review threads and comments
- Provide a short summary of what each fix would require
- Ask which comments should be addressed

### 3) Apply fixes

- Implement fixes for selected comments
- Commit and push changes

## Notes

- The script outputs JSON to stdout — pipe to a file if needed: `> pr_comments.json`
- If `gh` hits auth/rate issues, re-authenticate with `gh auth login`
- Works with any GitHub-hosted repo (public or private with appropriate token scopes)
