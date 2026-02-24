import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ── Queries ──

/** List all active facts, optionally filtered by layer and/or author. */
export const listActive = query({
  args: {
    layer: v.optional(v.number()),
    authorAgent: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let q;
    if (args.layer !== undefined) {
      q = ctx.db
        .query("facts")
        .withIndex("by_layer", (q) =>
          q.eq("layer", args.layer!).eq("isActive", true)
        );
    } else if (args.authorAgent !== undefined) {
      q = ctx.db
        .query("facts")
        .withIndex("by_author", (q) =>
          q.eq("authorAgent", args.authorAgent!).eq("isActive", true)
        );
    } else {
      q = ctx.db
        .query("facts")
        .withIndex("by_active", (q) => q.eq("isActive", true));
    }
    const facts = await q.collect();

    // Apply additional filters in memory
    return facts.filter((f) => {
      if (args.scope && f.scope !== args.scope) return false;
      if (args.authorAgent && args.layer !== undefined && f.authorAgent !== args.authorAgent) return false;
      return true;
    });
  },
});

/** Get a single fact by factId. */
export const getByFactId = query({
  args: { factId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("facts")
      .withIndex("by_factId", (q) => q.eq("factId", args.factId))
      .first();
  },
});

/** Get the supersession chain for a fact (all versions). */
export const getSupersessionChain = query({
  args: { factId: v.string() },
  handler: async (ctx, args) => {
    // Get the current fact
    const current = await ctx.db
      .query("facts")
      .withIndex("by_factId", (q) => q.eq("factId", args.factId))
      .first();
    if (!current) return [];

    // Get all facts that supersede this one
    const superseding = await ctx.db
      .query("facts")
      .withIndex("by_supersedes", (q) =>
        q.eq("supersedesFactId", args.factId)
      )
      .collect();

    return [current, ...superseding];
  },
});

// ── Mutations ──

/** Insert a new fact. If it supersedes another, deactivate the old one. */
export const create = mutation({
  args: {
    factId: v.string(),
    factText: v.string(),
    layer: v.number(),
    scope: v.union(
      v.literal("global"),
      v.literal("task"),
      v.literal("hypothetical"),
      v.literal("draft")
    ),
    visibility: v.union(v.literal("team"), v.literal("agent-private")),
    authorAgent: v.string(),
    sourceType: v.union(
      v.literal("conversation"),
      v.literal("policy"),
      v.literal("system"),
      v.literal("cross-agent")
    ),
    authority: v.union(
      v.literal("user"),
      v.literal("agent"),
      v.literal("policy"),
      v.literal("system")
    ),
    supersedesFactId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    sessionKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // If superseding, deactivate the old fact
    if (args.supersedesFactId) {
      const oldFact = await ctx.db
        .query("facts")
        .withIndex("by_factId", (q) =>
          q.eq("factId", args.supersedesFactId!)
        )
        .first();
      if (oldFact) {
        await ctx.db.patch(oldFact._id, { isActive: false });
      }
    }

    const id = await ctx.db.insert("facts", {
      ...args,
      isActive: true,
      createdAt: Date.now(),
    });

    return id;
  },
});

/** Batch insert multiple facts (used by extraction pipeline). */
export const createBatch = mutation({
  args: {
    facts: v.array(
      v.object({
        factId: v.string(),
        factText: v.string(),
        layer: v.number(),
        scope: v.union(
          v.literal("global"),
          v.literal("task"),
          v.literal("hypothetical"),
          v.literal("draft")
        ),
        visibility: v.union(v.literal("team"), v.literal("agent-private")),
        authorAgent: v.string(),
        sourceType: v.union(
          v.literal("conversation"),
          v.literal("policy"),
          v.literal("system"),
          v.literal("cross-agent")
        ),
        authority: v.union(
          v.literal("user"),
          v.literal("agent"),
          v.literal("policy"),
          v.literal("system")
        ),
        supersedesFactId: v.optional(v.string()),
        dependsOn: v.optional(v.array(v.string())),
        sessionKey: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const ids = [];
    for (const fact of args.facts) {
      // Deactivate superseded facts
      if (fact.supersedesFactId) {
        const oldFact = await ctx.db
          .query("facts")
          .withIndex("by_factId", (q) =>
            q.eq("factId", fact.supersedesFactId!)
          )
          .first();
        if (oldFact) {
          await ctx.db.patch(oldFact._id, { isActive: false });
        }
      }

      const id = await ctx.db.insert("facts", {
        ...fact,
        isActive: true,
        createdAt: Date.now(),
      });
      ids.push(id);
    }
    return ids;
  },
});

/** Deactivate a fact (soft delete via supersession). */
export const deactivate = mutation({
  args: { factId: v.string() },
  handler: async (ctx, args) => {
    const fact = await ctx.db
      .query("facts")
      .withIndex("by_factId", (q) => q.eq("factId", args.factId))
      .first();
    if (!fact) throw new Error(`Fact not found: ${args.factId}`);
    await ctx.db.patch(fact._id, { isActive: false });
  },
});
