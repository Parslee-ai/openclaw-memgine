import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** Log an extraction event. */
export const create = mutation({
  args: {
    sessionKey: v.string(),
    turnIndex: v.number(),
    model: v.string(),
    factsExtracted: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("extraction_log", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

/** List recent extraction logs. */
export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("extraction_log")
      .order("desc")
      .take(args.limit ?? 50);
  },
});
