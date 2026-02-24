---
name: memgine-extraction
description: "Async end-of-turn fact extraction for Memgine"
homepage: https://github.com/kkeeling/openclaw
metadata:
  {
    "openclaw":
      {
        "emoji": "🔬",
        "events": ["message:sent"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# memgine-extraction

Async end-of-turn fact extraction for Memgine. After an agent sends a response, this hook triggers LLM-based fact extraction in the background.

## Configuration

```yaml
hooks:
  internal:
    enabled: true
    memgine-extraction:
      enabled: true
```

## Environment Variables

- `MEMGINE_CONVEX_SITE_URL` — Convex site URL (default: https://necessary-gecko-572.convex.site)
- `OPENROUTER_API_KEY` — API key for extraction LLM
- `OPENAI_API_KEY` — API key for embeddings
- `MEMGINE_EXTRACTION_MODEL` — Model for extraction (default: anthropic/claude-haiku-4-5)

## Events

- **message:sent**: Fires after agent response delivery, triggers async fact extraction

## How It Works

1. On `message:sent`, the hook checks if the message is worth extracting (skips trivial messages, HEARTBEAT_OK, etc.)
2. Calls the Memgine extraction HTTP endpoint asynchronously (fire-and-forget)
3. The extraction endpoint uses an LLM to extract structured facts
4. Facts are stored in the Convex fact store with vector embeddings
5. Extraction never blocks response delivery
