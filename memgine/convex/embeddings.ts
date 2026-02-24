import { v } from "convex/values";
import { mutation, action } from "./_generated/server";
import { api } from "./_generated/api";

/** Store an embedding for a fact. */
export const store = mutation({
  args: {
    factId: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    // Upsert: remove old embedding if exists
    const existing = await ctx.db
      .query("fact_embeddings")
      .withIndex("by_factId", (q) => q.eq("factId", args.factId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return await ctx.db.insert("fact_embeddings", {
      factId: args.factId,
      embedding: args.embedding,
    });
  },
});

/** Vector search: find facts most relevant to a query embedding. */
export const searchByVector = action({
  args: {
    queryEmbedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const results = await ctx.vectorSearch("fact_embeddings", "by_embedding", {
      vector: args.queryEmbedding,
      limit: args.limit ?? 64,
    });
    // Return factIds with scores
    return results.map((r) => ({
      factId: r.factId,
      score: r._score,
    }));
  },
});
