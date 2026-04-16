/**
 * Memgine v2 Phase C — Plugin RA Fixes Test Suite
 *
 * Tests for:
 * - RA-1: resolveWorkspaceDir with agentId fallback
 * - RA-2: Multi-agent channel→workspace routing maps
 * - RA-3: Dynamic context window config
 * - Hook registration (v1 vs v2)
 * - Edge cases: rapid restart, before_prompt_build before session_start, concurrent agents
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import memginePlugin from "../plugin.js";
import {
  clearEngineCache,
  clearRoutingMaps,
  getSessionWorkspace,
  getChannelWorkspace,
  sessionMapSize,
  channelMapSize,
  resolveWorkspaceDir,
} from "../plugin.js";
import { validateMemgineConfig } from "../plugin-config.js";

// ── Test Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memgine-ra-"));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

type MockApi = {
  on: ReturnType<typeof vi.fn>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  pluginConfig: Record<string, unknown>;
};

function makeApi(pluginConfig: Record<string, unknown> = {}): MockApi {
  return {
    on: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    pluginConfig,
  };
}

function getHook(api: MockApi, hookName: string): ((...args: unknown[]) => unknown) | undefined {
  const call = api.on.mock.calls.find((c) => c[0] === hookName);
  return call?.[1] as ((...args: unknown[]) => unknown) | undefined;
}

// ── RA-1: resolveWorkspaceDir ──────────────────────────────────────────────────

describe("RA-1: resolveWorkspaceDir", () => {
  it("returns workspaceDir when present", () => {
    const result = resolveWorkspaceDir({ workspaceDir: "/my/workspace" });
    expect(result).toBe("/my/workspace");
  });

  it("prefers workspaceDir over agentId", () => {
    const result = resolveWorkspaceDir({ workspaceDir: "/my/workspace", agentId: "agent-1" });
    expect(result).toBe("/my/workspace");
  });

  it("derives path from agentId when workspaceDir absent", () => {
    const result = resolveWorkspaceDir({ agentId: "agent-abc" });
    expect(result).toBe(path.join(os.homedir(), ".openclaw", "workspace-agent-abc"));
  });

  it("returns undefined when neither workspaceDir nor agentId provided", () => {
    expect(resolveWorkspaceDir({})).toBeUndefined();
    expect(resolveWorkspaceDir({ agentId: undefined })).toBeUndefined();
  });

  it("rejects agentId with path traversal (..)", () => {
    expect(resolveWorkspaceDir({ agentId: "../evil" })).toBeUndefined();
    expect(resolveWorkspaceDir({ agentId: "../../etc/passwd" })).toBeUndefined();
  });

  it("rejects agentId with forward slash", () => {
    expect(resolveWorkspaceDir({ agentId: "agent/sub" })).toBeUndefined();
  });

  it("rejects agentId with backslash", () => {
    expect(resolveWorkspaceDir({ agentId: "agent\\sub" })).toBeUndefined();
  });

  it("accepts normal agentId with special chars (dash, underscore, dot)", () => {
    const result = resolveWorkspaceDir({ agentId: "agent-01_v2.3" });
    expect(result).toBe(path.join(os.homedir(), ".openclaw", "workspace-agent-01_v2.3"));
  });
});

// ── RA-2: Routing Maps ────────────────────────────────────────────────────────

describe("RA-2: Session/Channel Routing Maps", () => {
  beforeEach(() => {
    clearEngineCache();
    clearRoutingMaps();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    clearEngineCache();
    clearRoutingMaps();
    cleanup(tmpDir);
  });

  it("sessionMapSize starts at 0", () => {
    expect(sessionMapSize()).toBe(0);
  });

  it("channelMapSize starts at 0", () => {
    expect(channelMapSize()).toBe(0);
  });

  it("getSessionWorkspace returns undefined for unknown session", () => {
    expect(getSessionWorkspace("unknown-session")).toBeUndefined();
  });

  it("getChannelWorkspace returns undefined for unknown channel", () => {
    expect(getChannelWorkspace("unknown-channel")).toBeUndefined();
  });

  it("session_start populates sessionToWorkspace", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const sessionStart = getHook(api, "session_start");
    expect(sessionStart).toBeDefined();

    const ws = tmpDir;
    await sessionStart!(
      { sessionId: "sess-1", sessionKey: "key-1" },
      { agentId: undefined, sessionId: "sess-1", sessionKey: "key-1", workspaceDir: ws },
    );

    expect(getSessionWorkspace("sess-1")).toBe(ws);
    expect(sessionMapSize()).toBe(1);
  });

  it("before_prompt_build populates both sessionToWorkspace and channelToWorkspace", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    // Prime the engine cache so before_prompt_build can find it
    const ws = tmpDir;
    const sessionStart = getHook(api, "session_start");
    await sessionStart!(
      { sessionId: "sess-2", sessionKey: "key-2" },
      { sessionId: "sess-2", sessionKey: "key-2", workspaceDir: ws },
    );

    const beforePromptBuild = getHook(api, "before_prompt_build");
    expect(beforePromptBuild).toBeDefined();

    await beforePromptBuild!(
      { prompt: "hello", messages: [] },
      { sessionId: "sess-2", channelId: "telegram", workspaceDir: ws },
    );

    expect(getSessionWorkspace("sess-2")).toBe(ws);
    expect(getChannelWorkspace("telegram")).toBe(ws);
    expect(channelMapSize()).toBe(1);
  });

  it("message_received skips with warning when no channelId mapping exists", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const messageReceived = getHook(api, "message_received");
    expect(messageReceived).toBeDefined();

    await messageReceived!(
      { from: "user", content: "hello", timestamp: Date.now() },
      { channelId: "unmapped-channel" },
    );

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no workspace for channelId unmapped-channel"),
    );
  });

  it("message_sent skips with warning when no channelId mapping exists", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const messageSent = getHook(api, "message_sent");
    expect(messageSent).toBeDefined();

    await messageSent!(
      { to: "user", content: "reply", success: true },
      { channelId: "unmapped-channel" },
    );

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no workspace for channelId unmapped-channel"),
    );
  });

  it("message_sent ignores failed sends without warning", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const messageSent = getHook(api, "message_sent");

    await messageSent!(
      { to: "user", content: "failed", success: false },
      { channelId: "some-channel" },
    );

    // success=false exits before the channelId lookup, so no warn
    expect(api.logger.warn).not.toHaveBeenCalled();
  });

  it("session_end cleans up session routing entry", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const ws = tmpDir;
    const sessionStart = getHook(api, "session_start");
    await sessionStart!(
      { sessionId: "sess-end", sessionKey: "key" },
      { sessionId: "sess-end", sessionKey: "key", workspaceDir: ws },
    );

    expect(getSessionWorkspace("sess-end")).toBe(ws);

    const sessionEnd = getHook(api, "session_end");
    await sessionEnd!(
      { sessionId: "sess-end", sessionKey: "key", messageCount: 0 },
      { sessionId: "sess-end", sessionKey: "key", workspaceDir: ws },
    );

    expect(getSessionWorkspace("sess-end")).toBeUndefined();
    expect(sessionMapSize()).toBe(0);
  });

  it("clearRoutingMaps resets all maps", () => {
    clearRoutingMaps();
    expect(sessionMapSize()).toBe(0);
    expect(channelMapSize()).toBe(0);
  });
});

// ── RA-2: Multi-Agent Isolation ───────────────────────────────────────────────

describe("RA-2: Multi-Agent Isolation", () => {
  let tmpDir2: string;

  beforeEach(() => {
    clearEngineCache();
    clearRoutingMaps();
    tmpDir = makeTmpDir();
    tmpDir2 = makeTmpDir();
  });

  afterEach(() => {
    clearEngineCache();
    clearRoutingMaps();
    cleanup(tmpDir);
    cleanup(tmpDir2);
  });

  it("two agents map to different workspaces via different channels", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const sessionStart = getHook(api, "session_start");
    const beforePromptBuild = getHook(api, "before_prompt_build");

    // Agent 1: session + channel
    await sessionStart!(
      { sessionId: "agent1-sess", sessionKey: "k1" },
      { sessionId: "agent1-sess", sessionKey: "k1", workspaceDir: tmpDir },
    );
    await beforePromptBuild!(
      { prompt: "agent1 prompt", messages: [] },
      { sessionId: "agent1-sess", channelId: "channel-agent1", workspaceDir: tmpDir },
    );

    // Agent 2: session + channel
    await sessionStart!(
      { sessionId: "agent2-sess", sessionKey: "k2" },
      { sessionId: "agent2-sess", sessionKey: "k2", workspaceDir: tmpDir2 },
    );
    await beforePromptBuild!(
      { prompt: "agent2 prompt", messages: [] },
      { sessionId: "agent2-sess", channelId: "channel-agent2", workspaceDir: tmpDir2 },
    );

    expect(getSessionWorkspace("agent1-sess")).toBe(tmpDir);
    expect(getSessionWorkspace("agent2-sess")).toBe(tmpDir2);
    expect(getChannelWorkspace("channel-agent1")).toBe(tmpDir);
    expect(getChannelWorkspace("channel-agent2")).toBe(tmpDir2);
    expect(sessionMapSize()).toBe(2);
    expect(channelMapSize()).toBe(2);
  });

  it("message_received routes to correct agent workspace", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const sessionStart = getHook(api, "session_start");
    const beforePromptBuild = getHook(api, "before_prompt_build");
    const messageReceived = getHook(api, "message_received");

    // Set up two agents
    await sessionStart!(
      { sessionId: "s1", sessionKey: "k1" },
      { sessionId: "s1", sessionKey: "k1", workspaceDir: tmpDir },
    );
    await beforePromptBuild!(
      { prompt: "p", messages: [] },
      { sessionId: "s1", channelId: "ch-a", workspaceDir: tmpDir },
    );

    await sessionStart!(
      { sessionId: "s2", sessionKey: "k2" },
      { sessionId: "s2", sessionKey: "k2", workspaceDir: tmpDir2 },
    );
    await beforePromptBuild!(
      { prompt: "p", messages: [] },
      { sessionId: "s2", channelId: "ch-b", workspaceDir: tmpDir2 },
    );

    // Ingest to agent 1 channel — should not warn
    await messageReceived!(
      { from: "user", content: "hi from agent1", timestamp: Date.now() },
      { channelId: "ch-a" },
    );

    // Ingest to agent 2 channel — should not warn
    await messageReceived!(
      { from: "user", content: "hi from agent2", timestamp: Date.now() },
      { channelId: "ch-b" },
    );

    expect(api.logger.warn).not.toHaveBeenCalled();
  });
});

// ── RA-3: Dynamic Context Window ──────────────────────────────────────────────

describe("RA-3: Dynamic Context Window", () => {
  it("defaults to 128000 when not specified", () => {
    const result = validateMemgineConfig({ version: 2 });
    expect(result.contextWindow).toBe(128000);
  });

  it("accepts a valid contextWindow", () => {
    const result = validateMemgineConfig({ version: 2, contextWindow: 32000 });
    expect(result.contextWindow).toBe(32000);
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts contextWindow at minimum boundary (2000)", () => {
    const result = validateMemgineConfig({ version: 2, contextWindow: 2000 });
    expect(result.contextWindow).toBe(2000);
    expect(result.warnings).toHaveLength(0);
  });

  it("clamps contextWindow below 2000 to 2000 with warning", () => {
    const result = validateMemgineConfig({ version: 2, contextWindow: 500 });
    expect(result.contextWindow).toBe(2000);
    expect(result.warnings.some((w) => w.includes("minimum 2000"))).toBe(true);
  });

  it("clamps contextWindow=0 to 2000 with warning", () => {
    const result = validateMemgineConfig({ version: 2, contextWindow: 0 });
    expect(result.contextWindow).toBe(2000);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects negative contextWindow with warning, uses default", () => {
    const result = validateMemgineConfig({ version: 2, contextWindow: -1000 });
    expect(result.contextWindow).toBe(128000);
    expect(result.warnings.some((w) => w.includes("negative"))).toBe(true);
  });

  it("returns contextWindow from validateMemgineConfig with no config", () => {
    const result = validateMemgineConfig();
    expect(result.contextWindow).toBe(128000);
  });

  it("accepts large contextWindow (200k)", () => {
    const result = validateMemgineConfig({ version: 2, contextWindow: 200000 });
    expect(result.contextWindow).toBe(200000);
    expect(result.warnings).toHaveLength(0);
  });
});

// ── Hook Registration ─────────────────────────────────────────────────────────

describe("Hook Registration", () => {
  it("registers exactly 5 hooks for version 2", () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    expect(api.on).toHaveBeenCalledTimes(5);
    const hookNames = api.on.mock.calls.map((c) => c[0]);
    expect(hookNames).toContain("session_start");
    expect(hookNames).toContain("before_prompt_build");
    expect(hookNames).toContain("message_received");
    expect(hookNames).toContain("message_sent");
    expect(hookNames).toContain("session_end");
  });

  it("registers no hooks for version 1", () => {
    const api = makeApi({ version: 1 });
    memginePlugin.register!(api as never);

    expect(api.on).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("version is not 2"),
    );
  });

  it("registers no hooks when version defaults to 1 (no config)", () => {
    const api = makeApi({});
    memginePlugin.register!(api as never);

    expect(api.on).not.toHaveBeenCalled();
  });
});

// ── Edge Cases ────────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
  beforeEach(() => {
    clearEngineCache();
    clearRoutingMaps();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    clearEngineCache();
    clearRoutingMaps();
    cleanup(tmpDir);
  });

  it("rapid session restart: second session_start overwrites first session mapping", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const sessionStart = getHook(api, "session_start");
    const ws1 = tmpDir;
    const ws2 = makeTmpDir();

    try {
      // First start
      await sessionStart!(
        { sessionId: "rapid-sess", sessionKey: "k1" },
        { sessionId: "rapid-sess", sessionKey: "k1", workspaceDir: ws1 },
      );
      expect(getSessionWorkspace("rapid-sess")).toBe(ws1);

      // Second start (same sessionId, different workspace — simulates rapid restart)
      await sessionStart!(
        { sessionId: "rapid-sess", sessionKey: "k2" },
        { sessionId: "rapid-sess", sessionKey: "k2", workspaceDir: ws2 },
      );
      expect(getSessionWorkspace("rapid-sess")).toBe(ws2);
    } finally {
      cleanup(ws2);
    }
  });

  it("before_prompt_build before session_start: populates channel map, no crash", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const beforePromptBuild = getHook(api, "before_prompt_build");

    // Called without a prior session_start — engine won't be in cache yet, should no-op
    await beforePromptBuild!(
      { prompt: "cold start", messages: [] },
      { sessionId: "cold-sess", channelId: "cold-channel", workspaceDir: tmpDir },
    );

    // channelToWorkspace should be populated even though engine isn't loaded
    expect(getChannelWorkspace("cold-channel")).toBe(tmpDir);
  });

  it("5 concurrent agents all get isolated workspace mappings", async () => {
    const dirs: string[] = [];
    for (let i = 0; i < 5; i++) {
      dirs.push(makeTmpDir());
    }

    try {
      const api = makeApi({ version: 2 });
      memginePlugin.register!(api as never);

      const sessionStart = getHook(api, "session_start");
      const beforePromptBuild = getHook(api, "before_prompt_build");

      // Start 5 agents concurrently
      await Promise.all(
        dirs.map((ws, i) =>
          sessionStart!(
            { sessionId: `concurrent-sess-${i}`, sessionKey: `k${i}` },
            { sessionId: `concurrent-sess-${i}`, sessionKey: `k${i}`, workspaceDir: ws },
          ),
        ),
      );

      // Register channels
      await Promise.all(
        dirs.map((ws, i) =>
          beforePromptBuild!(
            { prompt: `prompt ${i}`, messages: [] },
            {
              sessionId: `concurrent-sess-${i}`,
              channelId: `concurrent-ch-${i}`,
              workspaceDir: ws,
            },
          ),
        ),
      );

      expect(sessionMapSize()).toBe(5);
      expect(channelMapSize()).toBe(5);

      for (let i = 0; i < 5; i++) {
        expect(getSessionWorkspace(`concurrent-sess-${i}`)).toBe(dirs[i]);
        expect(getChannelWorkspace(`concurrent-ch-${i}`)).toBe(dirs[i]);
      }
    } finally {
      for (const d of dirs) {cleanup(d);}
    }
  });

  it("unknown channelId in message_received is graceful no-op (no throw)", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const messageReceived = getHook(api, "message_received");

    // Should not throw
    expect(() =>
      messageReceived!({ from: "user", content: "hi", timestamp: Date.now() }, { channelId: "ghost-channel" }),
    ).not.toThrow();
  });

  it("session_end for unknown session is graceful no-op (no throw)", async () => {
    const api = makeApi({ version: 2 });
    memginePlugin.register!(api as never);

    const sessionEnd = getHook(api, "session_end");

    // workspaceDir not in engines — should not throw
    await expect(
      sessionEnd!(
        { sessionId: "ghost-sess", sessionKey: "k", messageCount: 0 },
        { sessionId: "ghost-sess", sessionKey: "k", workspaceDir: "/nonexistent/path" },
      ),
    ).resolves.toBeUndefined();
  });
});
