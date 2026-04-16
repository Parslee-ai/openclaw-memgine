---
name: security-threat-model
description: Repository-grounded threat modeling — enumerates trust boundaries, assets, attacker capabilities, abuse paths, and mitigations. Use when asked to threat model a codebase, enumerate threats, perform AppSec analysis, or assess attack surface. Triggers on "threat model", "attack surface", "security assessment", "enumerate threats".
---

# Threat Model Source Code Repo

Deliver an actionable AppSec-grade threat model grounded in the actual repo — not generic checklists. Anchor every claim to evidence in the code.

## References

- Prompt template: `~/openclaw/skills/security-threat-model/references/prompt-template.md`
- Controls & assets guide: `~/openclaw/skills/security-threat-model/references/security-controls-and-assets.md`

## Workflow

### 1) Scope and extract system model

- Identify components, data stores, external integrations from the repo
- Determine how the system runs (server, CLI, library, worker) and its entrypoints
- Separate runtime behavior from CI/build/dev tooling
- Do not claim components without evidence

### 2) Derive boundaries, assets, and entry points

- **Trust boundaries:** Concrete edges between components (protocol, auth, encryption, validation, rate limiting)
- **Assets:** Data, credentials, models, config, compute, audit logs
- **Entry points:** Endpoints, upload surfaces, parsers, job triggers, admin tooling, logging sinks

### 3) Calibrate attacker capabilities

- Realistic capabilities based on exposure and usage
- Explicitly note non-capabilities to avoid severity inflation

### 4) Enumerate threats as abuse paths

- Attacker goals → assets and boundaries (exfiltration, privilege escalation, integrity compromise, DoS)
- Keep threats small in number but high in quality

### 5) Prioritize

- Qualitative likelihood × impact (low/medium/high) with short justifications
- Overall priority: critical/high/medium/low
- State which assumptions most influence ranking

### 6) Validate with user

- Summarize key assumptions affecting threat ranking
- Ask 1–3 targeted questions to resolve missing context
- Pause for feedback before final report

### 7) Recommend mitigations

- Distinguish existing controls (with evidence) from recommended ones
- Tie to concrete locations and control types (authZ, input validation, schema enforcement, sandboxing, rate limits, secrets isolation, audit logging)
- Specific implementation hints over generic advice

### 8) Quality check

- Confirm all entry points are covered
- No orphaned threats without mitigations
- No mitigations without corresponding threats
- Assumptions are explicit

## Output

Concise Markdown threat model document. Use the prompt template from references for structure.
