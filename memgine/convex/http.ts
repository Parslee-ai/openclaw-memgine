import { httpRouter } from "convex/server";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

/**
 * POST /api/extract
 * Called by the memgine-extraction hook (fire-and-forget from gateway).
 * Receives conversation turn content and extracts facts via LLM.
 */
http.route({
  path: "/api/extract",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const {
      agentId,
      sessionKey,
      turnIndex,
      content,
      model,
      apiKey: bodyApiKey,
      openaiApiKey: bodyOpenaiKey,
    } = body as {
      agentId: string;
      sessionKey: string;
      turnIndex: number;
      content: string;
      model: string;
      apiKey?: string;
      openaiApiKey?: string;
    };

    if (!agentId || !content) {
      return new Response(JSON.stringify({ error: "Missing agentId or content" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Use OpenRouter or Anthropic for extraction (request body keys take precedence)
    const apiKey = bodyApiKey || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "No API key configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const extractionPrompt = `You are a fact extraction engine. Extract discrete facts from the following conversation turn.

For each fact, output a JSON object with:
- factText: the fact (concise, self-contained)
- layer: 1 (identity/role), 2 (persistent knowledge), 3 (current tasks/working), 4 (environmental/transient)
- scope: "global" (always relevant) or "task" (specific to current work)
- visibility: "team" (shareable) or "agent-private" (personal to this agent)
- sourceType: "conversation"

Output a JSON array of facts. If no meaningful facts, output [].

Agent: ${agentId}
Turn content:
${content.slice(0, 4000)}`;

    try {
      const isOpenRouter = !!bodyApiKey || !!process.env.OPENROUTER_API_KEY;
      const llmUrl = isOpenRouter
        ? "https://openrouter.ai/api/v1/chat/completions"
        : "https://api.anthropic.com/v1/messages";

      let facts: Array<{
        factText: string;
        layer: number;
        scope: string;
        visibility: string;
        sourceType: string;
      }> = [];

      if (isOpenRouter) {
        const resp = await fetch(llmUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model || "anthropic/claude-haiku-4-5",
            messages: [{ role: "user", content: extractionPrompt }],
            temperature: 0,
            max_tokens: 2000,
          }),
        });
        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`LLM error: ${resp.status} ${err}`);
        }
        const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
        const text = data.choices[0]?.message?.content || "[]";
        // Parse JSON from response (handle markdown code blocks)
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          facts = JSON.parse(jsonMatch[0]);
        }
      } else {
        const resp = await fetch(llmUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model || "claude-haiku-4-5-20241022",
            messages: [{ role: "user", content: extractionPrompt }],
            temperature: 0,
            max_tokens: 2000,
          }),
        });
        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`LLM error: ${resp.status} ${err}`);
        }
        const data = (await resp.json()) as { content: Array<{ text: string }> };
        const text = data.content[0]?.text || "[]";
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          facts = JSON.parse(jsonMatch[0]);
        }
      }

      if (facts.length === 0) {
        // Log extraction even if no facts
        await ctx.runMutation(api.extractionLog.create, {
          sessionKey: sessionKey || "unknown",
          turnIndex: turnIndex || 0,
          model: model || "unknown",
          factsExtracted: 0,
        });
        return new Response(JSON.stringify({ factsExtracted: 0 }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Generate embeddings for facts (request body key takes precedence)
      const openaiKey = bodyOpenaiKey || process.env.OPENAI_API_KEY;

      // Insert facts
      const factEntries = facts.map((f) => ({
        factId: `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        factText: f.factText,
        layer: f.layer,
        scope: (f.scope || "global") as "global" | "task" | "hypothetical" | "draft",
        visibility: (f.visibility || "team") as "team" | "agent-private",
        authorAgent: agentId,
        sourceType: (f.sourceType || "conversation") as
          | "conversation"
          | "policy"
          | "system"
          | "cross-agent",
        authority: "agent" as const,
        sessionKey,
      }));

      await ctx.runMutation(api.facts.createBatch, { facts: factEntries });

      // Generate and store embeddings if OpenAI key available
      if (openaiKey) {
        for (const entry of factEntries) {
          try {
            const embResp = await fetch("https://api.openai.com/v1/embeddings", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${openaiKey}`,
              },
              body: JSON.stringify({
                model: "text-embedding-3-small",
                input: entry.factText.slice(0, 8000),
              }),
            });
            if (embResp.ok) {
              const embData = (await embResp.json()) as { data: Array<{ embedding: number[] }> };
              await ctx.runMutation(api.embeddings.store, {
                factId: entry.factId,
                embedding: embData.data[0].embedding,
              });
            }
          } catch {
            // Non-fatal: fact stored without embedding
          }
        }
      }

      // Log extraction
      await ctx.runMutation(api.extractionLog.create, {
        sessionKey: sessionKey || "unknown",
        turnIndex: turnIndex || 0,
        model: model || "unknown",
        factsExtracted: facts.length,
      });

      return new Response(JSON.stringify({ factsExtracted: facts.length }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

/**
 * POST /api/action
 * Generic action dispatcher — used by the context hook to call assembleContext.
 */
http.route({
  path: "/api/action",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const { path, args } = body as { path: string; args: Record<string, unknown> };

    if (path === "engine:assembleContext") {
      const result = await ctx.runAction(
        api.engine.assembleContext,
        args as {
          queryEmbedding: number[];
          agentId: string;
          sessionType: string;
          budgets?: {
            identity?: number;
            persistent?: number;
            workingSet?: number;
            signals?: number;
          };
        },
      );
      return new Response(JSON.stringify({ value: result }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${path}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
