import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  facts: defineTable({
    factId: v.string(),
    factText: v.string(),
    layer: v.number(), // 1-4
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
    isActive: v.boolean(),
    sessionKey: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_layer", ["layer", "isActive"])
    .index("by_author", ["authorAgent", "isActive"])
    .index("by_scope", ["scope", "isActive"])
    .index("by_active", ["isActive"])
    .index("by_supersedes", ["supersedesFactId"])
    .index("by_factId", ["factId"]),

  fact_embeddings: defineTable({
    factId: v.string(),
    embedding: v.array(v.float64()),
  })
    .index("by_factId", ["factId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
    }),

  extraction_log: defineTable({
    sessionKey: v.string(),
    turnIndex: v.number(),
    model: v.string(),
    factsExtracted: v.number(),
    createdAt: v.number(),
  }).index("by_session", ["sessionKey", "createdAt"]),
});
