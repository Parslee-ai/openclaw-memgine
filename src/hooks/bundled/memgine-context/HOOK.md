---
name: memgine-context
description: "Inject Memgine fact-based context into agent bootstrap"
version: 0.1.0
homepage: https://github.com/kkeeling/openclaw
---

# memgine-context

Replaces flat-file memory (MEMORY.md, WORKING.md, daily notes) with structured fact-based context from the Memgine engine.

## Configuration

```yaml
hooks:
  internal:
    enabled: true
    memgine-context:
      enabled: true
      convexUrl: "https://necessary-gecko-572.convex.cloud"
      embeddingModel: "text-embedding-3-small"
      openaiApiKey: "${OPENAI_API_KEY}"
      budgets:
        identity: 8000
        persistent: 32000
        workingSet: 16000
        signals: 8000
```

## Events

- **agent:bootstrap**: Assembles context from Memgine fact store and injects as a bootstrap file

## How It Works

1. On `agent:bootstrap`, the hook:
   - Gets the current agent ID and session type from the event context
   - Generates an embedding for recent conversation context (or uses a default query)
   - Calls the Memgine `engine:assembleContext` action via Convex HTTP
   - Injects the assembled context as a virtual bootstrap file named `MEMGINE_CONTEXT.md`
2. Engine-level filtering ensures:
   - Agent-private facts are only visible to the authoring agent
   - Hypothetical/draft facts are excluded
   - Subagent/cron sessions get restricted access (Layer 1-2 only)
3. Facts are sorted with most-relevant LAST (recency bias exploitation)
