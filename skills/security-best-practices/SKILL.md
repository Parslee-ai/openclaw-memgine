---
name: security-best-practices
description: Perform language and framework-specific security best-practice reviews. Use when asked for a security review, security audit, secure coding guidance, or vulnerability assessment. Supports Python (Django, Flask, FastAPI), JavaScript/TypeScript (React, Vue, Express, Next.js, jQuery), and Go. Triggers on "security review", "security audit", "secure this code", "vulnerability check".
---

# Security Best Practices Review

## Overview

Identify languages and frameworks in the project, load relevant security guidance from bundled references, and either write secure code, passively detect vulnerabilities, or produce a full security report.

## Available References

Located at `~/openclaw/skills/security-best-practices/references/`:

### Python

- `python-django-web-server-security.md` — Django-specific (CSRF, ORM injection, settings, middleware)
- `python-flask-web-server-security.md` — Flask-specific
- `python-fastapi-web-server-security.md` — FastAPI-specific

### JavaScript/TypeScript

- `javascript-general-web-frontend-security.md` — Framework-agnostic frontend
- `javascript-typescript-react-web-frontend-security.md` — React-specific
- `javascript-typescript-vue-web-frontend-security.md` — Vue-specific
- `javascript-jquery-web-frontend-security.md` — jQuery-specific
- `javascript-express-web-server-security.md` — Express.js
- `javascript-typescript-nextjs-web-server-security.md` — Next.js

### Go

- `golang-general-backend-security.md`

## Workflow

### 1) Identify the stack

Inspect the repo to determine ALL languages and frameworks (frontend + backend). Focus on primary core frameworks.

### 2) Load relevant references

Read ALL reference files matching the detected stack. Filename pattern: `<language>-<framework>-<stack>-security.md`. Also check for `<language>-general-<stack>-security.md`.

For web apps with frontend + backend, load references for BOTH.

### 3) Operating modes

**Mode 1 — Secure by default (primary):** Use loaded guidance to write secure code going forward.

**Mode 2 — Passive detection:** While working on the project, flag critical vulnerabilities and major security issues. Focus on highest-impact items.

**Mode 3 — Security report (on request):** Full report with:

- Findings organized by severity (Critical / High / Medium / Low)
- Specific file locations and code snippets
- Recommended fixes with implementation hints
- Prioritized action items

### 4) If no reference exists

Use known security best practices for the language/framework. Note that concrete guidance is limited but still flag obvious critical vulnerabilities.

## Notes

- Project-specific overrides (in AGENTS.md, docs, etc.) may legitimately bypass certain practices — respect those.
- For bigeq: use the Django + general frontend references
- For agora: use the React reference
