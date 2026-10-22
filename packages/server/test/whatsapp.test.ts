import { describe, expect, it } from "vitest";
import type { Outbox, OutboundMessage, Principal } from "@open-instinct/core";
import { ChannelRouter, whatsappEnabled, WhatsAppWatch, type WhatsAppHealth } from "../src/whatsapp.js";

function recorder() {
  const sent: OutboundMessage[] = [];
  const typed: string[] = [];
  const outbox: Outbox = { send: async (msg) => void sent.push(msg), typing: async (key) => void typed.push(key) };
  return { outbox, sent, typed };
}

const ctx = { principal: { kind: "owner", id: "owner", tier: "owner" } as Principal, conversationKey: "k" };

describe("ChannelRouter", () => {
  it("sends whatsapp replies through WhatsApp and everything else through the default transport", async () => {
    const inkbox = recorder();
    const wa = recorder();
    const router = new ChannelRouter(inkbox.outbox, { whatsapp: wa.outbox });
    await router.send({ channel: "whatsapp", conversationKey: "whatsapp:447700900123@s.whatsapp.net", text: "hi" }, ctx);
    await router.send({ channel: "imessage", conversationKey: "imessage:c1", text: "hello" }, ctx);
    expect(wa.sent.map((m) => m.text)).toEqual(["hi"]);
    expect(inkbox.sent.map((m) => m.text)).toEqual(["hello"]);
    await router.typing("whatsapp:447700900123@s.whatsapp.net");
    await router.typing("imessage:c1");
    expect(wa.typed).toEqual(["whatsapp:447700900123@s.whatsapp.net"]);
    expect(inkbox.typed).toEqual(["imessage:c1"]);
  });
});

describe("whatsappEnabled", () => {
  it("is on with WHATSAPP_ENABLED=1 or the agent's number, off otherwise", () => {
    expect(whatsappEnabled({ WHATSAPP_ENABLED: "1" })).toBe(true);
    expect(whatsappEnabled({ WHATSAPP_PHONE: "+447700900123" })).toBe(true);
    expect(whatsappEnabled({ WHATSAPP_ENABLED: "0" })).toBe(false);
    expect(whatsappEnabled({})).toBe(false);
  });
});

describe("WhatsAppWatch", () => {
  const DAY = 24 * 60 * 60 * 1000;
  function watch(start: string, health: WhatsAppHealth = {}) {
    let now = new Date(start);
    let stored: WhatsAppHealth = health;
    const emails: Array<{ subject: string; body: string }> = [];
    const w = new WhatsAppWatch({
      load: () => stored,
      save: (h) => void (stored = h),
      email: async (subject, body) => void emails.push({ subject, body }),
      phone: "+447845995492",
      now: () => now,
    });
    return { w, emails, advance: (ms: number) => void (now = new Date(now.getTime() + ms)), stored: () => stored };
  }

  it("starts the clock on first run instead of warning about an unknown past", async () => {
    const t = watch("2026-10-22T08:00:00Z");
    await t.w.check();
    expect(t.stored().phoneSeenAt).toBe("2026-10-22T08:00:00.000Z");
    expect(t.emails).toHaveLength(0);
  });

  it("emails from day 11, at most once a day, until the phone is seen again", async () => {
    const t = watch("2026-10-22T08:00:00Z", { phoneSeenAt: "2026-10-22T08:00:00.000Z" });
    t.advance(10 * DAY);
    await t.w.check();
    expect(t.emails).toHaveLength(0);
    t.advance(1 * DAY);
    await t.w.check();
    expect(t.emails).toHaveLength(1);
    expect(t.emails[0]!.subject).toBe("Bobby's WhatsApp unlinks in 3 days");
    expect(t.emails[0]!.body).toContain("+447845995492");
    t.advance(60 * 60 * 1000);
    await t.w.check();
    expect(t.emails).toHaveLength(1);
    t.advance(DAY);
    await t.w.check();
    expect(t.emails).toHaveLength(2);
    t.w.phoneActive(new Date("2026-11-03T09:00:00Z"));
    t.advance(DAY);
    await t.w.check();
    expect(t.emails).toHaveLength(2);
  });

  it("emails at once when WhatsApp logs the agent out", async () => {
    const t = watch("2026-10-22T08:00:00Z");
    await t.w.loggedOut();
    expect(t.emails[0]!.subject).toBe("Bobby's WhatsApp was logged out");
    expect(t.emails[0]!.body).toContain("Link with phone number instead");
  });
});
