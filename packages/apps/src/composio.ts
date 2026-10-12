import type { RegisteredTool, StateDir } from "@open-instinct/core";
import { Composio } from "@composio/core";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { resolveAccounts, wrapAccountTool, type AccountsClientLike, type AppAccount } from "./accounts.js";
import { toolkitOfSlug } from "./capabilities.js";
import { wrapMcpTool, type McpToolSource } from "./wrap.js";

/** File under the StateDir that remembers the Composio session for this owner. */
export const APPS_STATE_FILE = "apps.json";

/**
 * The toolkit list that means "every toolkit Composio has". `COMPOSIO_TOOLKITS=all`
 * (or `*`) normalizes to `["*"]`. The session is then created without an allowlist,
 * so COMPOSIO_SEARCH_TOOLS and COMPOSIO_MANAGE_CONNECTIONS can reach any app the
 * owner names at runtime.
 */
export const ALL_TOOLKITS = "*";

/**
 * How the Tool Router exposes tools over MCP.
 * `direct` lists every allowed app tool (GMAIL_SEND_EMAIL, ...) so the policy
 * guard can tag each one. `router` lists only the meta tools (search, multi
 * execute, manage connections), which all map to `apps.use` + `trust.manage`.
 * The all-toolkits list always runs as `router`: Composio cannot list every tool
 * of every app directly.
 */
export type ComposioSessionMode = "direct" | "router";

/**
 * OpenAI-style chat completions APIs reject a request that carries more tools than
 * this ("Invalid 'tools': array too long"). The Maritime LLM proxy is one of them.
 */
export const OPENAI_COMPLETIONS_TOOL_LIMIT = 128;

/**
 * The session mode for this agent. `COMPOSIO_MODE=direct|router` wins. Unset, it is
 * `router` for a model served through an OpenAI-style chat completions API (the
 * Maritime LLM proxy among them), because direct Gmail plus Calendar alone lists
 * about a hundred tools and the agent's own tools push the request past
 * OPENAI_COMPLETIONS_TOOL_LIMIT, so every reply would fail. Any other model gets
 * `direct`, which lets the guard tag each app action.
 */
export function composioModeFor(
  env: { COMPOSIO_MODE?: string | undefined },
  modelApi: string | undefined,
): { mode: ComposioSessionMode; reason: string } {
  const raw = env.COMPOSIO_MODE?.trim().toLowerCase();
  if (raw === "direct" || raw === "router") return { mode: raw, reason: "COMPOSIO_MODE" };
  const ignored = raw ? `COMPOSIO_MODE=${env.COMPOSIO_MODE?.trim()} is not direct or router; ` : "";
  if (modelApi === "openai-completions") {
    return { mode: "router", reason: `${ignored}the model's chat completions API accepts at most ${OPENAI_COMPLETIONS_TOOL_LIMIT} tools` };
  }
  return { mode: "direct", reason: `${ignored}default` };
}

/**
 * Toolkits Composio refused because the project has no auth config for them. A
 * project without, say, a Google Contacts auth config answers session create with a
 * 400 ("... require auth configs but none exist") that names the toolkits. Only
 * names from `requested` count, matched as whole words. Empty for any other error.
 */
export function toolkitsWithoutAuthConfig(err: unknown, requested: string[]): string[] {
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== undefined && status !== 400) return [];
  const text = errorText(err).toLowerCase();
  if (!/auth[\s_-]*configs?\b/.test(text)) return [];
  return requested.filter((slug) => new RegExp(`(^|[^a-z0-9_])${escapeRegExp(slug)}($|[^a-z0-9_])`).test(text));
}

export interface ComposioAppsOptions {
  apiKey: string;
  /** Composio user id. One per owner; the Maritime externalId or Inkbox handle works well. */
  userId: string;
  /** Toolkit slugs, or `["all"]` / `["*"]` for every toolkit. */
  toolkits: string[];
  state: StateDir;
  logger?: (m: string) => void;
  /** Default `direct`. Ignored (treated as `router`) when toolkits is the all list. */
  mode?: ComposioSessionMode;
  /** Test seams. Production code leaves this out. */
  adapters?: {
    createComposio?: (apiKey: string) => ComposioClientLike;
    connectMcp?: (mcp: McpEndpoint) => Promise<McpToolSource>;
  };
}

export interface McpEndpoint {
  url: string;
  headers?: Record<string, string>;
}

/** Shape of what we persist in apps.json. `toolkits` is `["*"]` in all mode. */
export interface AppsState {
  sessionId: string;
  userId: string;
  toolkits: string[];
  mode: ComposioSessionMode;
  createdAt: string;
}

export interface ToolkitStatus {
  slug: string;
  connected: boolean;
}

/** The parts of a Composio Tool Router session this package uses. */
export interface ComposioSessionLike {
  sessionId: string;
  mcp: McpEndpoint;
  authorize(toolkit: string): Promise<{ redirectUrl?: string | null }>;
  toolkits(options?: { toolkits?: string[]; isConnected?: boolean; limit?: number; cursor?: string }): Promise<{
    items: Array<{ slug: string; isNoAuth?: boolean; connection?: { isActive: boolean } }>;
    nextCursor?: string | null;
  }>;
}

export interface ComposioClientLike extends Partial<AccountsClientLike> {
  sessions: {
    create(userId: string, config: SessionCreateConfig): Promise<ComposioSessionLike>;
    use(id: string, options: { mcp: true }): Promise<ComposioSessionLike>;
  };
}

/** Session create config. `toolkits` is left out in all mode: no allowlist means every toolkit. */
export interface SessionCreateConfig {
  toolkits?: string[];
  manageConnections: { enable: boolean };
  mcp: true;
  sessionPreset?: "direct_tools";
}

/** Pages of connected toolkits fetched in all mode before giving up. */
const MAX_CONNECTED_PAGES = 20;
/** Composio's connected-accounts endpoint rejects a limit above 50 with a 400. */
const CONNECTED_PAGE_SIZE = 50;

export class ComposioApps {
  private readonly opts: ComposioAppsOptions;
  private readonly composio: ComposioClientLike;
  private session?: ComposioSessionLike;
  private client?: McpToolSource;
  private connecting?: Promise<void>;
  private cachedTools?: RegisteredTool[];
  /** Toolkits dropped this run because the Composio project has no auth config for them. */
  private readonly unavailable = new Set<string>();

  constructor(opts: ComposioAppsOptions) {
    if (!opts.apiKey) throw new Error("ComposioApps needs an apiKey (COMPOSIO_API_KEY)");
    if (!opts.userId) throw new Error("ComposioApps needs a userId");
    this.opts = opts;
    const create = opts.adapters?.createComposio ?? defaultCreateComposio;
    this.composio = create(opts.apiKey);
  }

  /** The mode the session really runs in: `router` whenever every toolkit is allowed. */
  get mode(): ComposioSessionMode {
    if (this.allToolkits) return "router";
    return this.opts.mode ?? "direct";
  }

  /** True when the toolkit list is `all` / `*`: no allowlist, any app by name. */
  get allToolkits(): boolean {
    return wantsAllToolkits(this.opts.toolkits);
  }

  /** Normalized toolkit slugs, or `["*"]` in all mode. Leaves out toolkits Composio refused for lack of an auth config. */
  get toolkitSlugs(): string[] {
    return normalizeToolkits(this.opts.toolkits).filter((t) => !this.unavailable.has(t));
  }

  /** Configured toolkits left out of the session because the Composio project has no auth config for them. */
  get unavailableToolkits(): string[] {
    return [...this.unavailable].sort();
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /** Reuse the stored session when it still matches; otherwise create one and save it. Then open MCP. */
  async connect(): Promise<void> {
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async doConnect(): Promise<void> {
    const session = await this.openSession();
    this.session = session;
    const connectMcp = this.opts.adapters?.connectMcp ?? defaultConnectMcp;
    this.client = await connectMcp(session.mcp);
    this.cachedTools = undefined;
    this.log(`composio: MCP connected for session ${session.sessionId}`);
  }

  private async openSession(): Promise<ComposioSessionLike> {
    const saved = this.opts.state.readJson<AppsState | undefined>(APPS_STATE_FILE, undefined);
    if (saved && sessionMatches(saved, this.opts.userId, this.toolkitSlugs, this.mode)) {
      try {
        const session = await this.composio.sessions.use(saved.sessionId, { mcp: true });
        this.log(`composio: reusing session ${saved.sessionId}`);
        return session;
      } catch (err) {
        this.log(`composio: stored session unusable (${messageOf(err)}); creating a new one`);
      }
    } else if (saved) {
      this.log("composio: stored session config differs; creating a new one");
    }
    const config: SessionCreateConfig = {
      manageConnections: { enable: true },
      mcp: true,
    };
    if (this.allToolkits) {
      // No allowlist: the meta tools can search, run and connect any toolkit. The
      // direct preset needs a toolkit filter, so all mode is always router mode.
      if (this.opts.mode === "direct") this.log("composio: all toolkits requested; using router mode");
    } else {
      config.toolkits = this.toolkitSlugs;
      // direct_tools lists each app tool so the guard sees GMAIL_SEND_EMAIL, not a generic executor.
      if (this.mode === "direct") config.sessionPreset = "direct_tools";
    }
    const session = await this.createSession(config);
    const state: AppsState = {
      sessionId: session.sessionId,
      userId: this.opts.userId,
      toolkits: this.toolkitSlugs,
      mode: this.mode,
      createdAt: new Date().toISOString(),
    };
    this.opts.state.writeJson(APPS_STATE_FILE, state);
    this.log(`composio: created session ${session.sessionId}${this.allToolkits ? " (all toolkits)" : ""}`);
    return session;
  }

  /**
   * Create the session. When Composio refuses some toolkits for lack of an auth
   * config, drop those and retry once, so one missing config (Google Contacts in a
   * new project, typically) does not switch off every app. Any other error, or a
   * refusal that names every toolkit, is thrown as before.
   */
  private async createSession(config: SessionCreateConfig): Promise<ComposioSessionLike> {
    try {
      return await this.composio.sessions.create(this.opts.userId, config);
    } catch (err) {
      const requested = config.toolkits ?? [];
      const missing = toolkitsWithoutAuthConfig(err, requested);
      const rest = requested.filter((t) => !missing.includes(t));
      if (missing.length === 0 || rest.length === 0) throw err;
      for (const t of missing) this.unavailable.add(t);
      this.log(
        `composio: this Composio project has no auth config for ${missing.join(", ")}; starting with ${rest.join(", ")} only. ` +
          "Create the missing auth config in the Composio dashboard and restart the agent to add it.",
      );
      return await this.composio.sessions.create(this.opts.userId, { ...config, toolkits: rest });
    }
  }

  /**
   * Every MCP tool wrapped as a RegisteredTool. Cached after the first call. Tools of a
   * toolkit with several connected accounts run as the account the model names.
   */
  async tools(opts: { refresh?: boolean } = {}): Promise<RegisteredTool[]> {
    await this.connect();
    if (!this.cachedTools || opts.refresh) {
      const client = this.requireClient();
      const routed = await this.routedAccounts();
      const seen = new Set<string>();
      const out: RegisteredTool[] = [];
      for (const tool of await client.listTools()) {
        const accounts = routed.get(toolkitOfSlug(tool.name));
        const wrapped = accounts ? wrapAccountTool(tool, accounts, this.executeAs) : wrapMcpTool(client, tool);
        if (seen.has(wrapped.spec.name)) continue;
        seen.add(wrapped.spec.name);
        out.push(wrapped);
      }
      this.cachedTools = out;
      this.log(`composio: ${out.length} app tools`);
    }
    return this.cachedTools;
  }

  /** Accounts per toolkit, for toolkits with more than one connection. Empty until tools() ran. */
  accountsByToolkit(): Map<string, AppAccount[]> {
    return this.routed ?? new Map();
  }

  private routed?: Map<string, AppAccount[]>;

  private async routedAccounts(): Promise<Map<string, AppAccount[]>> {
    const client = this.composio;
    if (!client.connectedAccounts || !client.tools) return (this.routed = new Map());
    try {
      const { routed } = await resolveAccounts(client as AccountsClientLike, this.opts.userId, this.opts.state, (m) => this.log(m));
      for (const [toolkit, accounts] of routed) this.log(`composio: ${toolkit} accounts: ${accounts.map((a) => a.label).join(", ")}`);
      return (this.routed = routed);
    } catch (err) {
      // Accounts are an improvement on the session default, not a requirement to boot.
      this.log(`composio: could not list connected accounts (${messageOf(err)}); using the session defaults`);
      return (this.routed = new Map());
    }
  }

  private readonly executeAs = (slug: string, connectedAccountId: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    (this.composio as AccountsClientLike).tools.execute(
      slug,
      { userId: this.opts.userId, connectedAccountId, arguments: args, dangerouslySkipVersionCheck: true },
      signal ? { signal } : undefined,
    );

  /** OAuth link the owner opens to connect a toolkit. Undefined when the toolkit needs no auth. */
  async connectLink(toolkit: string): Promise<string | undefined> {
    await this.connect();
    const req = await this.requireSession().authorize(toolkit.trim().toLowerCase());
    return req.redirectUrl ?? undefined;
  }

  /**
   * Connection state of each configured toolkit. Toolkits missing from the response
   * count as not connected. In all mode there is no configured list, so this returns
   * the toolkits that hold an active connection, each marked connected.
   */
  async connectedToolkits(): Promise<ToolkitStatus[]> {
    await this.connect();
    if (this.allToolkits) return this.activeConnections();
    const wanted = this.toolkitSlugs;
    const res = await this.requireSession().toolkits({ toolkits: wanted, limit: Math.max(wanted.length, 1) });
    const found = new Map<string, boolean>();
    for (const item of res.items) {
      found.set(item.slug.toLowerCase(), item.isNoAuth === true || item.connection?.isActive === true);
    }
    return wanted.map((slug) => ({ slug, connected: found.get(slug) ?? false }));
  }

  private async activeConnections(): Promise<ToolkitStatus[]> {
    const session = this.requireSession();
    const slugs = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CONNECTED_PAGES; page += 1) {
      const res = await session.toolkits({ isConnected: true, limit: CONNECTED_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const item of res.items) {
        if (item.connection?.isActive === true) slugs.add(item.slug.toLowerCase());
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return [...slugs].sort().map((slug) => ({ slug, connected: true }));
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.cachedTools = undefined;
    if (client) await client.close();
  }

  private requireClient(): McpToolSource {
    if (!this.client) throw new Error("ComposioApps is not connected");
    return this.client;
  }

  private requireSession(): ComposioSessionLike {
    if (!this.session) throw new Error("ComposioApps is not connected");
    return this.session;
  }

  private log(m: string): void {
    this.opts.logger?.(m);
  }
}

/** True when the list names every toolkit: any entry is `all` or `*`. */
export function wantsAllToolkits(toolkits: string[]): boolean {
  return toolkits.some((t) => {
    const v = t.trim().toLowerCase();
    return v === "all" || v === ALL_TOOLKITS;
  });
}

/** Lowercase, trim, dedupe and sort. `all` or `*` anywhere in the list collapses it to `["*"]`. */
export function normalizeToolkits(toolkits: string[]): string[] {
  if (wantsAllToolkits(toolkits)) return [ALL_TOOLKITS];
  return [...new Set(toolkits.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

function sessionMatches(saved: AppsState, userId: string, toolkits: string[], mode: ComposioSessionMode): boolean {
  if (!saved.sessionId || saved.userId !== userId) return false;
  if ((saved.mode ?? "router") !== mode) return false;
  const a = normalizeToolkits(saved.toolkits ?? []);
  return a.length === toolkits.length && a.every((t, i) => t === toolkits[i]);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The error message plus any response body the SDK attached (`APIError.error`). */
function errorText(err: unknown): string {
  const parts = [messageOf(err)];
  const body = (err as { error?: unknown } | null)?.error;
  if (body !== undefined) {
    try {
      parts.push(typeof body === "string" ? body : JSON.stringify(body));
    } catch {
      // An unserializable body adds nothing.
    }
  }
  return parts.join(" ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultCreateComposio(apiKey: string): ComposioClientLike {
  // The SDK's Session type is wider than ComposioSessionLike; the structural subset is all we call.
  return new Composio({ apiKey });
}

async function defaultConnectMcp(mcp: McpEndpoint): Promise<McpToolSource> {
  const client = new McpClient({ name: "open-instinct-apps", version: "0.1.0" });
  await client.connect(new StreamableHttpTransport({ url: mcp.url, headers: mcp.headers ?? {} }));
  return client;
}
