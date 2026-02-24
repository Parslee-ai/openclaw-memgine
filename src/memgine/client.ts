/**
 * HTTP client for the Memgine Convex deployment.
 *
 * Uses fetch() to call Convex query/mutation/action functions
 * without pulling in the full Convex JS client.
 */

import type { Fact } from "./types.js";

/** Convex function reference for HTTP API calls. */
interface ConvexFunctionRef {
  path: string;
  args: Record<string, unknown>;
}

export class MemgineClient {
  private readonly baseUrl: string;

  constructor(convexUrl: string) {
    // Ensure trailing slash is stripped
    this.baseUrl = convexUrl.replace(/\/+$/, "");
  }

  /**
   * Call a Convex query function via the HTTP API.
   */
  private async query<T>(functionPath: string, args: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/api/query`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: functionPath,
        args,
        format: "json",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Memgine query ${functionPath} failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    return json.value as T;
  }

  /**
   * Call a Convex action function via the HTTP API.
   */
  private async action<T>(functionPath: string, args: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/api/action`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: functionPath,
        args,
        format: "json",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Memgine action ${functionPath} failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    return json.value as T;
  }

  /**
   * Fetch all active facts, optionally filtered by layer and/or author.
   */
  async fetchActiveFacts(filters?: {
    layer?: number;
    authorAgent?: string;
    scope?: string;
  }): Promise<Fact[]> {
    return this.query<Fact[]>("facts:listActive", filters ?? {});
  }

  /**
   * Fetch a single fact by its factId.
   */
  async getByFactId(factId: string): Promise<Fact | null> {
    return this.query<Fact | null>("facts:getByFactId", { factId });
  }

  /**
   * Vector search: find facts most relevant to a query embedding.
   * Returns factIds with relevance scores.
   */
  async searchByRelevance(
    queryEmbedding: number[],
    limit?: number,
  ): Promise<Array<{ factId: string; score: number }>> {
    return this.action<Array<{ factId: string; score: number }>>(
      "embeddings:searchByVector",
      { queryEmbedding, limit },
    );
  }
}
