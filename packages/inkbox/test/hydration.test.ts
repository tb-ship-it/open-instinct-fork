import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { AgentIdentity } from "@inkbox/sdk";
import type { InboundMessage } from "@open-instinct/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInkboxEvent } from "../src/events.js";
import { InkboxInboundHydrator } from "../src/hydration.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function harness(options: Partial<ConstructorParameters<typeof InkboxInboundHydrator>[0]> = {}) {
  const identity = {
    getIMessageConversation: vi.fn(async () => ({ isGroup: true, participants: ["+14155550100", "+14155550199"] })),
    listTextConversations: vi.fn(async (_opts?: unknown): Promise<unknown[]> => [{ id: "group_text", isGroup: true, participants: ["+14155550100", "+14155550199"] }]),
    getMessage: vi.fn(async () => ({ bodyText: "Complete message after the prefix", bodyHtml: null, attachmentMetadata: [{ filename: "photo #1.png", content_type: "image/png" }] })),
  };
  const channel = {
    identity: async () => identity as unknown as AgentIdentity,
    emailAttachment: vi.fn(async () => ({ url: "https://media.example.test/photo?signature=complete" })),
  };
  return { identity, channel, hydrator: new InkboxInboundHydrator({ channel, ...options }) };
}

function reaction(): InboundMessage {
  return parseInkboxEvent({ id: "evt_reaction", event_type: "imessage.reaction_received", data: { reaction: { id: "reaction_1", conversation_id: "group_imessage", remote_number: "+14155550100", target_message_id: "message_1", reaction: "like" } } })!;
}

function email(): InboundMessage {
  return parseInkboxEvent({ id: "evt_email", event_type: "message.received", data: { message: { id: "mail_1", from_address: "sam@example.com", subject: "Details", body: "Prefix", body_state: "truncated", body_truncated: true, has_attachments: true } } })!;
}

describe("conversation hydration", () => {
  it("resolves group membership for a reaction before the owner can be treated as a private sender", async () => {
    const { hydrator, identity } = harness();
    const raw = reaction();
    const hydrated = await hydrator.hydrate(raw);
    expect(identity.getIMessageConversation).toHaveBeenCalledWith("group_imessage");
    expect(hydrated.meta).toMatchObject({ isGroup: true, conversationScopeKnown: true, participants: ["+14155550100", "+14155550199"] });
    expect(raw.meta?.conversationScopeKnown).toBe(false);
  });

  it("keeps different text conversations separate and loads group membership", async () => {
    const { hydrator } = harness();
    const event = (id: string) => parseInkboxEvent({ id, event_type: "text.received", data: { text_message: { id, conversation_id: id, sender_phone_number: "+14155550100", remote_phone_number: "+14155550999", text: "Hello" } } })!;
    const group = await hydrator.hydrate(event("group_text"));
    expect(group.conversationKey).toBe("sms:group_text");
    expect(group.from).toBe("+14155550100");
    expect(group.meta?.isGroup).toBe(true);
    expect(event("direct_text").conversationKey).not.toBe(group.conversationKey);
  });

  it("paginates text conversations instead of assuming a missing first-page match is private", async () => {
    const { hydrator, identity } = harness();
    identity.listTextConversations.mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => ({ id: `other_${i}`, isGroup: false, participants: [] })));
    const msg: InboundMessage = { ...reaction(), channel: "sms", conversationKey: "sms:group_text", replyRef: { conversationId: "group_text" } };
    expect((await hydrator.hydrate(msg)).meta?.isGroup).toBe(true);
    expect(identity.listTextConversations).toHaveBeenNthCalledWith(2, { limit: 200, offset: 200, includeGroups: true });
  });

  it("does not admit unavailable conversation metadata as a direct conversation", async () => {
    const { hydrator, identity } = harness();
    identity.getIMessageConversation.mockRejectedValueOnce(new Error("temporary outage"));
    await expect(hydrator.hydrate(reaction())).rejects.toThrow("temporary outage");
    identity.listTextConversations.mockResolvedValueOnce([]);
    await expect(hydrator.hydrate({ ...reaction(), channel: "sms" })).rejects.toThrow(/conversation details are unavailable/);
    await expect(hydrator.hydrate({ ...reaction(), replyRef: {} })).rejects.toThrow(/conversation/);
  });

  it("uses membership already present on a message without a second lookup", async () => {
    const { hydrator, identity } = harness();
    await hydrator.hydrate({ ...reaction(), meta: { conversationScopeKnown: true, isGroup: false } });
    expect(identity.getIMessageConversation).not.toHaveBeenCalled();
  });
});

describe("email and media hydration", () => {
  it("retrieves the complete email and attachment URLs instead of presenting a prefix as complete", async () => {
    const { hydrator, identity, channel } = harness();
    const msg = await hydrator.hydrate(email());
    expect(identity.getMessage).toHaveBeenCalledWith("mail_1");
    expect(msg.text).toBe("Subject: Details\n\nComplete message after the prefix");
    expect(msg.meta).toMatchObject({ bodyTruncated: false, bodyUnavailable: false });
    expect(channel.emailAttachment).toHaveBeenCalledWith("mail_1", "photo #1.png");
    expect(msg.attachments).toEqual([{ name: "photo #1.png", mimeType: "image/png", url: "https://media.example.test/photo?signature=complete" }]);
  });

  it("does not fetch complete emails without attachments, and retries failed full-body retrieval", async () => {
    const { hydrator, identity } = harness();
    await hydrator.hydrate({ ...email(), meta: {} });
    expect(identity.getMessage).not.toHaveBeenCalled();
    identity.getMessage.mockRejectedValueOnce(new Error("mail temporarily unavailable"));
    await expect(hydrator.hydrate(email())).rejects.toThrow(/temporarily unavailable/);
  });

  it("downloads the full signed URL to a generated workspace filename without API credentials", async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), "instinct-media-"));
    dirs.push(mediaDir);
    const url = `https://media.example.test/photo?token=${"x".repeat(650)}&signature=complete`;
    const fetchImpl = vi.fn(async () => new Response("image bytes")) as unknown as typeof fetch;
    const { hydrator } = harness({ mediaDir, fetchImpl, lookup: async () => ["8.8.8.8"] });
    const msg = await hydrator.hydrate({ ...reaction(), channel: "email", meta: {}, attachments: [{ name: "../../photo.png", mimeType: "image/png", url }] });
    const file = msg.attachments![0]!.path!;
    expect(dirname(file)).toBe(mediaDir);
    expect(await readFile(file, "utf8")).toBe("image bytes");
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ headers: { accept: "*/*" }, redirect: "manual" }));
  });

  it("names phone voice notes from their content type, since they carry no filename", async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), "instinct-media-"));
    dirs.push(mediaDir);
    const fetchImpl = vi.fn(async () => new Response("audio bytes")) as unknown as typeof fetch;
    const { hydrator } = harness({ mediaDir, fetchImpl, lookup: async () => ["8.8.8.8"] });
    const attachments = [
      { mimeType: "audio/mp4", url: "https://media.example.test/a" },
      { mimeType: "audio/AMR", url: "https://media.example.test/b" },
      { mimeType: "audio/ogg; codecs=opus", url: "https://media.example.test/c" },
    ];
    const msg = await hydrator.hydrate({ ...email(), meta: {}, attachments });
    expect(msg.attachments!.map((a) => extname(a.path!))).toEqual([".m4a", ".amr", ".ogg"]);
  });

  it("keeps a visible fallback when media is too large or points to a local host", async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), "instinct-media-"));
    dirs.push(mediaDir);
    const fetchImpl = vi.fn(async () => new Response("too many bytes")) as unknown as typeof fetch;
    const { hydrator } = harness({ mediaDir, fetchImpl, lookup: async () => ["8.8.8.8"], maxAttachmentBytes: 2 });
    const attachments = [{ url: "https://media.example.test/large" }, { url: "http://127.0.0.1/private" }];
    const msg = await hydrator.hydrate({ ...email(), meta: {}, attachments });
    expect(msg.attachments).toEqual(attachments);
    expect(msg.text).toContain("could not be downloaded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
