/**
 * WhatsApp wiring: when it is on, and how its replies are told apart from Inkbox's.
 * The channel itself lives in @open-instinct/whatsapp.
 */
import type { Outbox, OutboundMessage, Principal } from "@open-instinct/core";

/** On when WHATSAPP_ENABLED=1, or when the agent's WhatsApp number is set. */
export function whatsappEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.WHATSAPP_ENABLED?.trim() === "1" || Boolean(env.WHATSAPP_PHONE?.trim());
}

/**
 * Sends each message through the transport that owns its channel, and everything else
 * through the default one. Typing indicators follow the conversation key's prefix.
 */
export class ChannelRouter implements Outbox {
  constructor(
    private readonly fallback: Outbox,
    private readonly routes: Partial<Record<OutboundMessage["channel"], Outbox>>,
  ) {}

  async send(msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    await (this.routes[msg.channel] ?? this.fallback).send(msg, ctx);
  }

  async typing(conversationKey: string): Promise<void> {
    const prefix = conversationKey.split(":", 1)[0] as OutboundMessage["channel"];
    const route = this.routes[prefix];
    await (route ? route.typing?.(conversationKey) : this.fallback.typing?.(conversationKey));
  }
}

/** WhatsApp logs linked devices out when the phone holding the account is away this long. */
export const WHATSAPP_PHONE_LIMIT_DAYS = 14;
/** Start emailing the owner this many days after the phone was last seen. */
export const WHATSAPP_WARN_AFTER_DAYS = 11;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WhatsAppHealth {
  /** When the phone was last seen online: it linked this device, or sent a message itself. */
  phoneSeenAt?: string;
  lastWarnedAt?: string;
}

export interface WhatsAppWatchOptions {
  load(): WhatsAppHealth;
  save(health: WhatsAppHealth): void;
  /** Sends the owner an email. Rejects when it could not. */
  email(subject: string, body: string): Promise<void>;
  /** The agent's WhatsApp number, for the message. */
  phone?: string;
  now?: () => Date;
  log?: (m: string) => void;
}

/**
 * Emails the owner before WhatsApp unlinks the agent for want of its phone, and the moment it
 * has. Linked devices cannot see when the phone was last online, so the clock starts when the
 * phone links the agent and restarts whenever the phone sends a message itself.
 */
export class WhatsAppWatch {
  private readonly now: () => Date;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: WhatsAppWatchOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
  }

  phoneActive(at: Date): void {
    this.opts.save({ phoneSeenAt: at.toISOString() });
  }

  /** Call on a schedule (hourly). Emails at most once a day from day 11 until the phone is seen. */
  async check(): Promise<void> {
    const now = this.now();
    const health = this.opts.load();
    if (!health.phoneSeenAt) {
      // First run with this check: count from now rather than warn about an unknown past.
      this.opts.save({ phoneSeenAt: now.toISOString() });
      return;
    }
    const seen = new Date(health.phoneSeenAt);
    const idleDays = (now.getTime() - seen.getTime()) / DAY_MS;
    if (idleDays < WHATSAPP_WARN_AFTER_DAYS) return;
    if (health.lastWarnedAt && now.getTime() - new Date(health.lastWarnedAt).getTime() < DAY_MS) return;

    const deadline = new Date(seen.getTime() + WHATSAPP_PHONE_LIMIT_DAYS * DAY_MS);
    const left = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / DAY_MS));
    const number = this.opts.phone ? ` (${this.opts.phone})` : "";
    const subject = left > 0 ? `Bobby's WhatsApp unlinks in ${left} day${left === 1 ? "" : "s"}` : "Bobby's WhatsApp may unlink today";
    const body = [
      `WhatsApp unlinks me if the phone holding my number${number} goes ${WHATSAPP_PHONE_LIMIT_DAYS} days without connecting.`,
      `I last saw that phone on ${formatDay(seen)}, so the cut-off is around ${formatDay(deadline)}.`,
      "",
      "To reset it: on that phone, open WhatsApp Business and send any message from it (the \"Message yourself\" chat is fine). I'll stop reminding you as soon as I see it.",
    ].join("\n");
    try {
      await this.opts.email(subject, body);
      this.opts.save({ ...health, lastWarnedAt: now.toISOString() });
      this.log(`whatsapp: emailed the owner, phone last seen ${Math.floor(idleDays)} days ago`);
    } catch (err) {
      this.log(`whatsapp: could not email the 14-day reminder: ${(err as Error).message}`);
    }
  }

  async loggedOut(): Promise<void> {
    const body = [
      "WhatsApp has logged me out, so I can't read or send WhatsApp messages until I'm linked again. Texts and email still work.",
      "",
      "To relink, on Rufus:",
      "  sudo systemctl restart instinct",
      "  journalctl -u instinct -f | grep -i whatsapp",
      "then, on the phone holding my number: WhatsApp Business > Settings > Linked devices > Link a device > Link with phone number instead, and type the code from the log.",
    ].join("\n");
    try {
      await this.opts.email("Bobby's WhatsApp was logged out", body);
    } catch (err) {
      this.log(`whatsapp: could not email the logout notice: ${(err as Error).message}`);
    }
  }
}

function formatDay(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" });
}
