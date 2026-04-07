import { v } from "convex/values";
import { api } from "./_generated/api";
import { mutation, query, action } from "./_generated/server";

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

/** Fetch fact_embeddings documents by their IDs (used internally after vector search). */
export const getByIds = query({
  args: {
    ids: v.array(v.id("fact_embeddings")),
  },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs;
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

    if (results.length === 0) {
      return [];
    }

    // vectorSearch returns { _id, _score } — fetch full documents to get factId
    const docs = await ctx.runQuery(api.embeddings.getByIds, {
      ids: results.map((r) => r._id),
    });

    // Zip factIds with scores, skipping any deleted documents
    const scoreMap = new Map(results.map((r) => [r._id.toString(), r._score]));
    return docs
      .filter((d): d is NonNullable<typeof d> => d != null)
      .map((d) => ({
        factId: d.factId,
        score: scoreMap.get(d._id.toString()) ?? 0,
      }));
  },
});
