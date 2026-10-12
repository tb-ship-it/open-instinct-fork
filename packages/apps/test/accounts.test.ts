import { describe, expect, it } from "vitest";
import type { StateDir, ToolContext } from "@open-instinct/core";
import { ACCOUNTS_STATE_FILE, resolveAccounts, wrapAccountTool, type AccountsClientLike, type ConnectedAccountLike, type ExecuteResultLike } from "../src/accounts.js";
import { ComposioApps, type ComposioClientLike } from "../src/composio.js";
import { appsGuidance } from "../src/guidance.js";
import type { McpToolSource } from "../src/wrap.js";

function fakeState(initial: Record<string, unknown> = {}): StateDir & { files: Record<string, unknown> } {
  const files: Record<string, unknown> = { ...initial };
  return {
    files,
    readJson: <T>(name: string, fallback: T): T => (name in files ? (files[name] as T) : fallback),
    writeJson: (name: string, value: unknown) => {
      files[name] = JSON.parse(JSON.stringify(value));
    },
  } as unknown as StateDir & { files: Record<string, unknown> };
}

const ACCOUNTS: ConnectedAccountLike[] = [
  { id: "ca_cal1", status: "ACTIVE", toolkit: { slug: "googlecalendar" } },
  { id: "ca_cal2", status: "ACTIVE", toolkit: { slug: "googlecalendar" } },
  { id: "ca_tb", status: "ACTIVE", toolkit: { slug: "gmail" } },
  { id: "ca_found", status: "ACTIVE", toolkit: { slug: "gmail" } },
  { id: "ca_dead", status: "ACTIVE", toolkit: { slug: "gmail" } },
  { id: "ca_old", status: "EXPIRED", toolkit: { slug: "gmail" } },
  { id: "ca_sheets", status: "ACTIVE", alias: "googlesheets_one", toolkit: { slug: "googlesheets" } },
];

const PROFILE: Record<string, ExecuteResultLike> = {
  ca_tb: { successful: true, data: { emailAddress: "tb@thomasbailly.com" } },
  ca_found: { successful: true, data: { emailAddress: "Thomas@FoundCapital.co.uk" } },
  ca_dead: { successful: false, error: "403 Forbidden", data: {} },
  ca_cal1: { successful: true, data: { calendar_data: { id: "tb@thomasbailly.com" } } },
  ca_cal2: { successful: true, data: { calendar_data: { id: "thomas@foundcapital.co.uk" } } },
};

function fakeClient(accounts = ACCOUNTS) {
  const calls: Array<{ slug: string; connectedAccountId: string; arguments: Record<string, unknown> }> = [];
  const client: AccountsClientLike = {
    connectedAccounts: { list: async () => ({ items: accounts }) },
    tools: {
      execute: async (slug, body) => {
        calls.push({ slug, connectedAccountId: body.connectedAccountId, arguments: body.arguments });
        if (slug === "GMAIL_GET_PROFILE" || slug === "GOOGLECALENDAR_GET_CALENDAR") return PROFILE[body.connectedAccountId] ?? { successful: false, error: "unknown" };
        return { successful: true, data: { id: "draft_1", account: body.connectedAccountId } };
      },
    },
  };
  return { client, calls };
}

const ctx = {} as ToolContext;

describe("resolveAccounts", () => {
  it("labels accounts by the address they act as, drops dead ones and remembers the labels", async () => {
    const state = fakeState();
    const { client, calls } = fakeClient();
    const logs: string[] = [];
    const { routed } = await resolveAccounts(client, "bobby", state, (m) => logs.push(m));
    expect(routed.get("gmail")!.map((a) => [a.id, a.label])).toEqual([
      ["ca_tb", "tb@thomasbailly.com"],
      ["ca_found", "thomas@foundcapital.co.uk"],
    ]);
    expect(routed.get("googlecalendar")!.map((a) => a.label)).toEqual(["tb@thomasbailly.com", "thomas@foundcapital.co.uk"]);
    expect(routed.has("googlesheets")).toBe(false); // one connection: nothing to choose, nothing read
    expect(calls.map((c) => c.connectedAccountId).sort()).toEqual(["ca_cal1", "ca_cal2", "ca_dead", "ca_found", "ca_tb"]);
    expect(logs.join("\n")).toContain("ca_dead left out (403 Forbidden)");
    expect(state.files[ACCOUNTS_STATE_FILE]).toMatchObject({ ca_tb: { label: "tb@thomasbailly.com" }, ca_dead: { broken: "403 Forbidden" } });

    // The next boot reads only what it could not label.
    calls.length = 0;
    await resolveAccounts(client, "bobby", state);
    expect(calls.map((c) => c.connectedAccountId)).toEqual(["ca_dead"]);
  });

  it("pins a toolkit whose other connections are dead to the live one", async () => {
    const { client } = fakeClient(ACCOUNTS.filter((a) => a.id !== "ca_found"));
    const { routed } = await resolveAccounts(client, "bobby", fakeState());
    expect(routed.get("gmail")!.map((a) => a.label)).toEqual(["tb@thomasbailly.com"]);
  });
});

describe("wrapAccountTool", () => {
  const tool = { name: "GMAIL_CREATE_EMAIL_DRAFT", description: "Create a draft.", inputSchema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] } };
  const accounts = [
    { id: "ca_tb", toolkit: "gmail", label: "tb@thomasbailly.com" },
    { id: "ca_found", toolkit: "gmail", label: "thomas@foundcapital.co.uk" },
  ];

  it("requires an account and runs as it", async () => {
    const runs: Array<[string, string, Record<string, unknown>]> = [];
    const wrapped = wrapAccountTool(tool, accounts, async (slug, id, args) => {
      runs.push([slug, id, args]);
      return { successful: true, data: { id: "d1" } };
    });
    const params = wrapped.spec.parameters as unknown as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(params.required).toEqual(["account", "subject"]);
    expect(params.properties.account!.enum).toEqual(["tb@thomasbailly.com", "thomas@foundcapital.co.uk"]);
    expect(wrapped.spec.name).toBe("app_gmail_create_email_draft");

    const ok = await wrapped.spec.execute({ account: "Thomas@foundcapital.co.uk", subject: "Hi" }, ctx);
    expect(runs).toEqual([["GMAIL_CREATE_EMAIL_DRAFT", "ca_found", { subject: "Hi" }]]);
    expect(JSON.stringify(ok)).toContain("As thomas@foundcapital.co.uk");

    const missing = await wrapped.spec.execute({ subject: "Hi" }, ctx);
    expect(missing.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("reports a failed call with the account it ran as", async () => {
    const wrapped = wrapAccountTool(tool, accounts, async () => ({ successful: false, error: "quota" }));
    const out = await wrapped.spec.execute({ account: "tb@thomasbailly.com", subject: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain("Failed as tb@thomasbailly.com: quota");
  });

  it("with one live account, takes no account and always runs as it", async () => {
    const runs: string[] = [];
    const wrapped = wrapAccountTool(tool, accounts.slice(0, 1), async (_s, id) => {
      runs.push(id);
      return { successful: true, data: {} };
    });
    expect((wrapped.spec.parameters as unknown as { properties: object }).properties).not.toHaveProperty("account");
    await wrapped.spec.execute({ subject: "x" }, ctx);
    expect(runs).toEqual(["ca_tb"]);
  });
});

describe("ComposioApps with several accounts", () => {
  it("routes multi-account toolkits through direct execute and leaves the rest on MCP", async () => {
    const { client, calls } = fakeClient();
    const mcpCalls: string[] = [];
    const composio: ComposioClientLike = {
      ...client,
      sessions: {
        create: async () => ({ sessionId: "s1", mcp: { url: "https://x/s1" }, authorize: async () => ({}), toolkits: async () => ({ items: [] }) }),
        use: async () => {
          throw new Error("unused");
        },
      },
    };
    const source: McpToolSource = {
      listTools: async () => [
        { name: "GMAIL_CREATE_EMAIL_DRAFT", inputSchema: { type: "object", properties: {} } },
        { name: "GOOGLESHEETS_BATCH_GET", inputSchema: { type: "object", properties: {} } },
      ],
      callTool: async (name) => {
        mcpCalls.push(name);
        return { content: [] };
      },
      close: async () => undefined,
    };
    const apps = new ComposioApps({ apiKey: "k", userId: "bobby", toolkits: ["gmail", "googlesheets"], state: fakeState(), adapters: { createComposio: () => composio, connectMcp: async () => source } });
    const tools = await apps.tools();
    const draft = tools.find((t) => t.spec.name === "app_gmail_create_email_draft")!;
    const sheets = tools.find((t) => t.spec.name === "app_googlesheets_batch_get")!;
    calls.length = 0;
    await draft.spec.execute({ account: "tb@thomasbailly.com" }, ctx);
    await sheets.spec.execute({}, ctx);
    expect(calls.map((c) => [c.slug, c.connectedAccountId])).toEqual([["GMAIL_CREATE_EMAIL_DRAFT", "ca_tb"]]);
    expect(mcpCalls).toEqual(["GOOGLESHEETS_BATCH_GET"]);
    expect([...apps.accountsByToolkit().keys()].sort()).toEqual(["gmail", "googlecalendar"]);
  });
});

describe("appsGuidance with several accounts", () => {
  it("tells the model to choose and name the account", () => {
    const g = appsGuidance(["gmail"], [], { accounts: { gmail: ["tb@thomasbailly.com", "thomas@foundcapital.co.uk"], googlesheets: ["x"] } });
    expect(g).toContain("gmail (tb@thomasbailly.com, thomas@foundcapital.co.uk)");
    expect(g).toContain('take "account"');
    expect(g).not.toContain("googlesheets (");
  });
});
