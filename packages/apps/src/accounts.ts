/**
 * Several accounts on one app: two Gmails, two calendars. The Tool Router session acts as
 * one default account per toolkit, so for a toolkit with more than one usable account the
 * app tools take an `account` argument and run through Composio's direct execute as that
 * connected account. Accounts are told apart by the address they act as, found once with
 * a cheap read (Gmail profile, primary calendar) and remembered in apps-accounts.json.
 * Connections that fail that read (revoked, or replaced by a newer sign-in) are left out.
 */
import type { RegisteredTool, StateDir, ToolContext, ToolResultLike, ToolSpec } from "@open-instinct/core";
import type { Tool as McpTool } from "@earendil-works/pi-mcp";
import { Type, type TSchema } from "typebox";
import { toolkitOfSlug } from "./capabilities.js";
import { metaFor, toolNameFor } from "./wrap.js";

export const ACCOUNTS_STATE_FILE = "apps-accounts.json";

export interface ConnectedAccountLike {
  id: string;
  status?: string;
  isDisabled?: boolean;
  alias?: string | null;
  toolkit?: { slug?: string };
}

export interface ExecuteResultLike {
  data?: unknown;
  error?: string | null;
  successful?: boolean;
}

export interface ExecuteBody {
  userId: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
  dangerouslySkipVersionCheck: boolean;
}

/** The parts of the Composio client used for accounts. The real client has both. */
export interface AccountsClientLike {
  connectedAccounts: { list(query: { userIds: string[] }): Promise<{ items: ConnectedAccountLike[] }> };
  tools: { execute(slug: string, body: ExecuteBody, options?: { signal?: AbortSignal }): Promise<ExecuteResultLike> };
}

export interface AppAccount {
  id: string;
  toolkit: string;
  /** The address the account acts as, or Composio's alias when it cannot be read. */
  label: string;
}

interface Remembered {
  toolkit: string;
  label?: string;
  broken?: string;
  checkedAt: string;
}

/** How to read which address a connected account acts as. */
const IDENTITY: Record<string, { slug: string; args: Record<string, unknown>; pick: (data: unknown) => unknown }> = {
  gmail: { slug: "GMAIL_GET_PROFILE", args: { user_id: "me" }, pick: (d) => field(d, "emailAddress") ?? field(field(d, "response_data"), "emailAddress") },
  googlecalendar: { slug: "GOOGLECALENDAR_GET_CALENDAR", args: { calendar_id: "primary" }, pick: (d) => field(field(d, "calendar_data"), "id") ?? field(d, "id") },
};

export interface ResolvedAccounts {
  /** Usable accounts, labelled. */
  accounts: AppAccount[];
  /**
   * Toolkits with more than one active connection. Their tools run as a named connected
   * account: the session's default could be any of them, including a dead one.
   */
  routed: Map<string, AppAccount[]>;
}

/**
 * Usable connected accounts, labelled. Only toolkits with more than one active connection are
 * read (one connection needs no choosing); labels are remembered so later boots skip the read.
 */
export async function resolveAccounts(client: AccountsClientLike, userId: string, state: StateDir, log: (m: string) => void = () => {}): Promise<ResolvedAccounts> {
  const res = await client.connectedAccounts.list({ userIds: [userId] });
  const active = (res.items ?? []).filter((a) => a.status === "ACTIVE" && !a.isDisabled && a.toolkit?.slug);
  const perToolkit = new Map<string, number>();
  for (const a of active) perToolkit.set(a.toolkit!.slug!.toLowerCase(), (perToolkit.get(a.toolkit!.slug!.toLowerCase()) ?? 0) + 1);

  const memory = state.readJson<Record<string, Remembered>>(ACCOUNTS_STATE_FILE, {});
  const next: Record<string, Remembered> = {};
  const out: AppAccount[] = [];
  for (const a of active) {
    const toolkit = a.toolkit!.slug!.toLowerCase();
    const fallback = a.alias?.trim() || a.id;
    if ((perToolkit.get(toolkit) ?? 0) < 2) {
      out.push({ id: a.id, toolkit, label: memory[a.id]?.label ?? fallback });
      if (memory[a.id]) next[a.id] = memory[a.id]!;
      continue;
    }
    const known = memory[a.id];
    if (known?.label) {
      next[a.id] = known;
      out.push({ id: a.id, toolkit, label: known.label });
      continue;
    }
    const probe = IDENTITY[toolkit];
    if (!probe) {
      out.push({ id: a.id, toolkit, label: fallback });
      continue;
    }
    const checkedAt = new Date().toISOString();
    try {
      const r = await client.tools.execute(probe.slug, { userId, connectedAccountId: a.id, arguments: probe.args, dangerouslySkipVersionCheck: true });
      const label = r.successful === false ? undefined : probe.pick(r.data);
      if (typeof label === "string" && label.trim()) {
        next[a.id] = { toolkit, label: label.trim().toLowerCase(), checkedAt };
        out.push({ id: a.id, toolkit, label: label.trim().toLowerCase() });
      } else {
        next[a.id] = { toolkit, broken: String(r.error ?? "no address in the reply").slice(0, 200), checkedAt };
        log(`composio: ${toolkit} account ${a.id} left out (${next[a.id]!.broken})`);
      }
    } catch (err) {
      next[a.id] = { toolkit, broken: (err instanceof Error ? err.message : String(err)).slice(0, 200), checkedAt };
      log(`composio: ${toolkit} account ${a.id} left out (${next[a.id]!.broken})`);
    }
  }
  state.writeJson(ACCOUNTS_STATE_FILE, next);

  // Two connections to the same address (a repeated sign-in): keep the first listed.
  const seen = new Set<string>();
  const accounts = out.filter((a) => {
    const key = `${a.toolkit}:${a.label}`;
    if (seen.has(key)) {
      log(`composio: duplicate ${a.toolkit} connection for ${a.label} (${a.id}) ignored`);
      return false;
    }
    seen.add(key);
    return true;
  });
  const routed = new Map<string, AppAccount[]>();
  for (const [toolkit, count] of perToolkit) {
    const usable = accounts.filter((a) => a.toolkit === toolkit);
    if (count > 1 && usable.length > 0) routed.set(toolkit, usable);
  }
  return { accounts, routed };
}

export type AccountExecutor = (slug: string, connectedAccountId: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ExecuteResultLike>;

/**
 * Wrap one app tool so it runs as a named connected account. With several accounts it takes
 * `account`; with one (the others being dead) it always runs as that one.
 */
export function wrapAccountTool(tool: McpTool, accounts: AppAccount[], execute: AccountExecutor): RegisteredTool {
  const slug = tool.name;
  const upper = slug.toUpperCase();
  const toolkit = toolkitOfSlug(slug);
  const labels = accounts.map((a) => a.label);
  const choose = accounts.length > 1;
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const parameters: TSchema = Type.Unsafe(
    choose
      ? {
          ...schema,
          type: "object",
          properties: {
            account: { type: "string", enum: labels, description: `Which of the owner's ${toolkit} accounts to act as.` },
            ...(schema.properties ?? {}),
          },
          required: ["account", ...(schema.required ?? []).filter((r) => r !== "account")],
        }
      : { ...schema, type: "object", properties: schema.properties ?? {} },
  );
  const spec: ToolSpec<TSchema> = {
    name: toolNameFor(slug),
    label: tool.title ?? slug,
    description: choose ? `${tool.description ?? slug} Acts as the ${toolkit} account named in "account" (${labels.join(", ")}).` : `${tool.description ?? slug} Acts as ${labels[0]}.`,
    parameters,
    meta: metaFor(upper),
    execute: async (args, _ctx: ToolContext, signal?: AbortSignal): Promise<ToolResultLike> => {
      const { account, ...rest } = (args ?? {}) as Record<string, unknown>;
      const chosen = choose ? accounts.find((a) => a.label === String(account ?? "").trim().toLowerCase()) : accounts[0];
      if (!chosen) {
        return { content: [{ type: "text", text: `Say which ${toolkit} account to act as: account must be one of ${labels.join(", ")}.` }], isError: true };
      }
      try {
        const r = await execute(upper, chosen.id, rest, signal);
        const failed = r.successful === false || Boolean(r.error);
        const body = failed ? `Failed as ${chosen.label}: ${r.error ?? "unknown error"}${r.data ? `\n${safeJson(r.data)}` : ""}` : `As ${chosen.label}:\n${safeJson(r.data)}`;
        return { content: [{ type: "text", text: body }], details: r.data, isError: failed };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed as ${chosen.label}: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  };
  return { spec };
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
