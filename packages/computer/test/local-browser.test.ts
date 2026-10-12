import { describe, expect, it } from "vitest";
import type { CallToolResult, JsonRpcMessage, Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import type { Principal, ToolContext } from "@open-instinct/core";
import { LocalBrowserBackend, browserGuidance, detectComputer, playwrightMcpConfig } from "../src/index.js";
import { unreachableFetch } from "./fake-fetch.js";

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
const ctx: ToolContext = { principal: owner, conversationKey: "chat:test", channel: "chat", now: () => new Date() };

const TOOLS: Tool[] = [
  { name: "browser_navigate", description: "Navigate to a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_click", description: "Click an element", inputSchema: { type: "object", properties: { element: { type: "string" }, ref: { type: "string" } }, required: ["ref"] } },
  { name: "browser_install", description: "Install the browser", inputSchema: { type: "object" } },
  { name: "browser_run_code", description: "Run Playwright code", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
];

/** Every connect gets a fresh in-memory server, as every spawn gets a fresh process. */
function fakeSpawner() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let spawns = 0;
  const factory = (): InMemoryTransport => {
    spawns++;
    const pair = createInMemoryTransportPair();
    pair.server.onMessage((message: JsonRpcMessage) => {
      if (!("method" in message) || !("id" in message)) return;
      const params = (message.params ?? {}) as Record<string, unknown>;
      const reply = (result: unknown) => void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize") reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-playwright", version: "0" } });
      else if (message.method === "tools/list") reply({ tools: TOOLS });
      else if (message.method === "tools/call") {
        calls.push({ name: String(params.name), args: (params.arguments ?? {}) as Record<string, unknown> });
        reply({ content: [{ type: "text", text: "- heading \"Flights\" [ref=e3]" }] } satisfies CallToolResult);
      } else reply({});
    });
    void pair.server.start();
    return pair.client;
  };
  return { factory, calls, spawns: () => spawns };
}

function backend(idleMs = 60_000) {
  const spawner = fakeSpawner();
  const b = new LocalBrowserBackend({
    executablePath: "/usr/bin/chromium-headless-shell",
    profileDir: "/tmp/profile",
    outputDir: "/tmp/out",
    configPath: "/tmp/playwright-mcp.json",
    idleMs,
    transportFactory: spawner.factory,
  });
  return { b, spawner };
}

describe("LocalBrowserBackend", () => {
  it("offers the browser tools as owner-only computer tools, withholding install and code execution", async () => {
    const { b } = backend();
    const tools = await b.tools();
    expect(tools.map((t) => t.spec.name)).toEqual(["browser_navigate", "browser_click"]);
    expect(tools[0]!.spec.meta).toMatchObject({ capabilities: ["computer.use"], group: "computer" });
    expect(b.kind).toBe("browser");
    expect(b.guidance()).toBe(browserGuidance());
    await b.close();
  });

  it("starts the server for a call and stops it again after the idle time", async () => {
    const { b, spawner } = backend(30);
    const [navigate] = await b.tools();
    expect(spawner.spawns()).toBe(1); // listing the tools, then let go
    const out = await navigate!.spec.execute({ url: "https://www.finnair.com/gb-en" }, ctx);
    expect(JSON.stringify(out)).toContain("Flights");
    expect(spawner.calls).toEqual([{ name: "browser_navigate", args: { url: "https://www.finnair.com/gb-en" } }]);
    expect(spawner.spawns()).toBe(2);
    await navigate!.spec.execute({ url: "https://example.com/" }, ctx);
    expect(spawner.spawns()).toBe(2); // still warm
    await new Promise((r) => setTimeout(r, 80));
    await navigate!.spec.execute({ url: "https://example.com/" }, ctx);
    expect(spawner.spawns()).toBe(3); // stopped while idle, started again
    await b.close();
  });
});

describe("playwrightMcpConfig", () => {
  it("runs headless Chromium with a persistent profile, no QUIC, the owner's locale and timezone, and no code snippets", () => {
    const cfg = playwrightMcpConfig({ executablePath: "/usr/bin/chromium-headless-shell", profileDir: "/d/browser/profile", outputDir: "/d/workspace/browser", timezone: "Europe/London" });
    expect(cfg.browser.launchOptions).toMatchObject({ executablePath: "/usr/bin/chromium-headless-shell", headless: true });
    expect(cfg.browser.launchOptions.args).toContain("--disable-quic");
    expect(cfg.browser).toMatchObject({ isolated: false, userDataDir: "/d/browser/profile", contextOptions: { locale: "en-GB", timezoneId: "Europe/London" } });
    expect(cfg).toMatchObject({ outputDir: "/d/workspace/browser", codegen: "none" });
  });
});

describe("detectComputer with a local browser", () => {
  const browser = { executablePath: "/usr/bin/chromium-headless-shell", profileDir: "/p", outputDir: "/o", configPath: "/c.json" };

  it("mode browser uses it; auto falls back to it when there is no desktop", async () => {
    expect((await detectComputer({ mode: "browser", browser }))?.kind).toBe("browser");
    expect((await detectComputer({ mode: "auto", fetchImpl: unreachableFetch(), browser }))?.kind).toBe("browser");
    expect(await detectComputer({ mode: "auto", fetchImpl: unreachableFetch() })).toBeUndefined();
  });

  it("mode browser without Chromium says how to install it", async () => {
    await expect(detectComputer({ mode: "browser", browser: { ...browser, executablePath: undefined } })).rejects.toThrow(/chromium-headless-shell/);
  });
});
