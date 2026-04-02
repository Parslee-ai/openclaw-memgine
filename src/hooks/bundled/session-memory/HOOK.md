---
name: session-memory
description: "Save session context to memory when /new or /reset command is issued"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

Extracts session context on `/new` or `/reset` and forwards it to the memgine fact store for structured memory. Falls back to writing markdown files when memgine is unreachable.

## What It Does

When you run `/new` or `/reset` to start a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Forwards to memgine** - POSTs the conversation summary to the Convex `/api/extract` endpoint for structured fact extraction
4. **Fallback** - If memgine is unreachable, writes a markdown file to `<workspace>/memory/YYYY-MM-DD-slug.md` as a safety net

## Memgine Integration

The hook sends session-boundary conversation summaries to the same extraction endpoint used by per-turn extraction (`memgine-extraction`). This captures cross-turn patterns (themes, decisions, outcomes) that individual turn extractions might miss.

The memgine extraction endpoint URL is resolved from:

1. Hook config `convexSiteUrl` (via `resolveHookConfig`)
2. Environment variable `MEMGINE_CONVEX_SITE_URL`

## Configuration

| Option              | Type    | Default | Description                                                   |
| ------------------- | ------- | ------- | ------------------------------------------------------------- |
| `messages`          | number  | 15      | Number of user/assistant messages to extract                  |
| `archiveToMarkdown` | boolean | false   | Also write markdown files alongside memgine forwarding        |
| `convexSiteUrl`     | string  | env     | Convex site URL (falls back to `MEMGINE_CONVEX_SITE_URL` env) |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25,
          "archiveToMarkdown": false
        }
      }
    }
  }
}
```

## Graceful Degradation

- If memgine forwarding fails and `archiveToMarkdown` is `false`, the hook falls back to writing a markdown file (safety net for session-boundary data)
- If memgine forwarding succeeds and `archiveToMarkdown` is `false`, no markdown file is written
- If `archiveToMarkdown` is `true`, markdown files are always written regardless of memgine status

## Disabling

```bash
openclaw hooks disable session-memory
```

Or in config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false }
      }
    }
  }
}
```
