/**
 * Pick a desktop at boot. The in-VM desktop wins when desktopd answers; the hosted MCP is the
 * fallback when the deployment has a Maritime key; otherwise the agent runs without a computer.
 *
 * Maritime starts the desktop stack (Xvnc, the window manager, desktopd) in the background
 * and execs the image entrypoint right away, so on a cold boot desktopd is often not
 * listening yet. When the environment says a desktop exists (`expectDesktopd`, from
 * MARITIME_DESKTOP=1) or the mode forces desktopd, the probe is retried with backoff for
 * up to a minute before we conclude it is absent. Plain "auto" keeps the single fast probe.
 */
import { DEFAULT_DESKTOPD_URL, DesktopdBackend, DesktopdClient, type DesktopdHealth } from "./desktopd.js";
import { existsSync } from "node:fs";
import { DEFAULT_MARITIME_MCP_URL, MaritimeMcpBackend } from "./maritime.js";
import { LOCAL_BROWSER_CANDIDATES, LocalBrowserBackend, type LocalBrowserBackendOptions } from "./local-browser.js";
import type { ComputerBackend, ComputerMode, Logger } from "./types.js";

export interface DetectComputerOptions {
  mode: ComputerMode;
  desktopdUrl?: string;
  maritimeMcpUrl?: string;
  maritimeApiKey?: string;
  /** The local browser, used by mode "browser" and as the last resort of "auto". */
  browser?: Omit<LocalBrowserBackendOptions, "executablePath" | "logger"> & { executablePath?: string };
  externalUserId?: string;
  /** Maritime agent id for the dashboard link in takeover hints. */
  agentId?: string;
  /**
   * The platform says this VM has a desktop (MARITIME_DESKTOP=1), so a refused probe means
   * "not up yet", not "not there". Health is polled with backoff before giving up.
   */
  expectDesktopd?: boolean;
  /** Total time to wait for desktopd when polling. Default 60 s. */
  desktopdWaitMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Test seams for the backoff sleep and the clock it is measured against. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DESKTOPD_WAIT_MS = 60_000;
/** Backoff between health probes: 1 s, 2 s, 4 s, then every 5 s. */
export const DESKTOPD_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 5_000];

export interface WaitForDesktopdOptions {
  client: Pick<DesktopdClient, "health">;
  /** Total budget in ms. 0 means a single probe. */
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /** Test seam for the clock. */
  now?: () => number;
}

/**
 * Probe desktopd until it answers ok or the budget runs out. Returns the health payload
 * or undefined. The first probe is immediate; later ones follow DESKTOPD_BACKOFF_MS.
 */
export async function waitForDesktopd(opts: WaitForDesktopdOptions): Promise<DesktopdHealth | undefined> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + Math.max(0, opts.waitMs);
  let attempt = 0;
  for (;;) {
    const health = await opts.client.health();
    if (health) return health;
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    const step = DESKTOPD_BACKOFF_MS[Math.min(attempt, DESKTOPD_BACKOFF_MS.length - 1)] ?? 5_000;
    const wait = Math.min(step, remaining);
    if (attempt === 0) opts.logger?.(`desktopd not answering yet; waiting up to ${Math.round(opts.waitMs / 1000)} s for it to start`);
    attempt += 1;
    await sleep(wait);
  }
}

export async function detectComputer(opts: DetectComputerOptions): Promise<ComputerBackend | undefined> {
  const log = opts.logger ?? (() => {});
  const desktopdUrl = opts.desktopdUrl ?? DEFAULT_DESKTOPD_URL;
  // A key alone is enough for the hosted fallback; the production URL is the default.
  const maritimeUrl = opts.maritimeMcpUrl ?? (opts.maritimeApiKey ? DEFAULT_MARITIME_MCP_URL : undefined);

  const desktopd = () =>
    new DesktopdBackend({ url: desktopdUrl, fetchImpl: opts.fetchImpl, agentId: opts.agentId, logger: log });
  const maritime = () => {
    if (!maritimeUrl || !opts.maritimeApiKey) {
      throw new Error("computer mode \"maritime\" needs maritimeMcpUrl (MARITIME_COMPUTERS_MCP_URL) and maritimeApiKey (MARITIME_API_KEY)");
    }
    return new MaritimeMcpBackend({
      url: maritimeUrl,
      apiKey: opts.maritimeApiKey,
      externalUserId: opts.externalUserId,
      fetchImpl: opts.fetchImpl,
      logger: log,
    });
  };
  const probe = (waitMs: number) =>
    waitForDesktopd({
      client: new DesktopdClient({ url: desktopdUrl, fetchImpl: opts.fetchImpl }),
      waitMs,
      sleep: opts.sleep,
      now: opts.now,
      logger: log,
    });
  const waitMs = opts.desktopdWaitMs ?? DESKTOPD_WAIT_MS;
  const localBrowser = (): LocalBrowserBackend | undefined => {
    if (!opts.browser) return undefined;
    const executablePath = opts.browser.executablePath ?? LOCAL_BROWSER_CANDIDATES.find((p) => existsSync(p));
    return executablePath ? new LocalBrowserBackend({ ...opts.browser, executablePath, logger: log }) : undefined;
  };

  switch (opts.mode) {
    case "none":
      return undefined;
    case "desktopd": {
      const health = await probe(waitMs);
      if (!health) log(`desktopd not reachable at ${desktopdUrl}; computer tools will fail until it is up`);
      return desktopd();
    }
    case "maritime":
      return maritime();
    case "browser": {
      const backend = localBrowser();
      if (!backend) throw new Error("computer mode \"browser\" needs Chromium: install chromium-headless-shell or set INSTINCT_BROWSER_PATH");
      return backend;
    }
    case "auto": {
      // With the platform flag a slow start is expected, so the probe gets the full budget.
      const health = await probe(opts.expectDesktopd ? waitMs : 0);
      if (health) {
        log(`desktop: desktopd at ${desktopdUrl} (mode ${String(health.mode ?? "agent")})`);
        return desktopd();
      }
      if (opts.expectDesktopd) {
        // The VM was created with a desktop. Keep the backend: its client turns an
        // unreachable server into error results, and desktopd will finish starting.
        log(`desktop: MARITIME_DESKTOP=1 but desktopd at ${desktopdUrl} is still starting; keeping the in-VM desktop`);
        return desktopd();
      }
      if (maritimeUrl && opts.maritimeApiKey) {
        log(`desktop: Maritime hosted computer (${maritimeUrl})`);
        return maritime();
      }
      const browser = localBrowser();
      if (browser) {
        log(`desktop: none; ${browser.describe()}`);
        return browser;
      }
      log("desktop: none (no desktopd, no Maritime key, no local Chromium)");
      return undefined;
    }
    default:
      throw new Error(`unknown computer mode "${String(opts.mode)}"; use auto, desktopd, maritime, browser or none`);
  }
}
