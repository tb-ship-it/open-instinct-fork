/** Resolve the conversation and content omitted from compact webhook payloads. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchPublic, htmlToText } from "@open-instinct/core";
import type { InboundMessage, Lookup } from "@open-instinct/core";
import type { InkboxChannel } from "./channel.js";

export const INBOUND_ATTACHMENT_LIMIT = 10;
export const INBOUND_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface HydrationOptions {
  channel: Pick<InkboxChannel, "identity" | "emailAttachment">;
  /** Files land inside the agent's workspace; omit to keep complete download URLs. */
  mediaDir?: string;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  maxAttachmentBytes?: number;
}

export class InkboxInboundHydrator {
  constructor(private readonly opts: HydrationOptions) {}

  async hydrate(message: InboundMessage): Promise<InboundMessage> {
    const msg: InboundMessage = { ...message, replyRef: { ...message.replyRef }, meta: { ...message.meta } };
    if ((msg.channel === "sms" || msg.channel === "imessage") && msg.meta?.conversationScopeKnown !== true) {
      await this.conversation(msg);
    }
    if (msg.channel === "email" && (msg.meta?.bodyTruncated || msg.meta?.bodyUnavailable || msg.meta?.hasAttachments)) {
      await this.email(msg);
    }
    if (this.opts.mediaDir && msg.attachments?.length) await this.downloadAttachments(msg);
    return msg;
  }

  private async conversation(msg: InboundMessage): Promise<void> {
    const id = msg.replyRef.conversationId;
    if (!id) throw new Error("Cannot resolve the incoming message's conversation");
    const identity = await this.opts.channel.identity();
    let scope: { isGroup: boolean; participants: string[] | null } | undefined;
    if (msg.channel === "imessage") {
      scope = await identity.getIMessageConversation(id);
    } else {
      // The text history endpoint returns messages, not conversation membership.
      const limit = 200;
      for (let offset = 0; offset < 10_000; offset += limit) {
        const page = await identity.listTextConversations({ limit, offset, includeGroups: true });
        scope = page.find((entry) => entry.id === id);
        if (scope || page.length < limit) break;
      }
    }
    if (!scope || typeof scope.isGroup !== "boolean") throw new Error("Incoming conversation details are unavailable; retry the event");
    msg.meta = { ...msg.meta, isGroup: scope.isGroup, participants: scope.participants ?? [], conversationScopeKnown: true };
  }

  private async email(msg: InboundMessage): Promise<void> {
    const id = msg.replyRef.inkboxMessageId;
    if (!id) throw new Error("Cannot retrieve the incoming email without its message id");
    const identity = await this.opts.channel.identity();
    const detail = await identity.getMessage(id);
    if (msg.meta?.bodyTruncated || msg.meta?.bodyUnavailable) {
      const body = detail.bodyText ?? (detail.bodyHtml ? htmlToText(detail.bodyHtml) : "");
      msg.text = `Subject: ${msg.replyRef.subject ?? "(no subject)"}\n\n${body}`;
      msg.meta = { ...msg.meta, bodyTruncated: false, bodyUnavailable: false };
    }
    const metadata = detail.attachmentMetadata ?? [];
    const attachments: NonNullable<InboundMessage["attachments"]> = [];
    for (const entry of metadata.slice(0, INBOUND_ATTACHMENT_LIMIT)) {
      const name = typeof entry.filename === "string" ? entry.filename : undefined;
      if (!name) continue;
      const signed = await this.opts.channel.emailAttachment(id, name);
      if (!signed.url) throw new Error("The email attachment download URL is unavailable");
      const mimeType = typeof entry.content_type === "string" ? entry.content_type : undefined;
      attachments.push({ url: signed.url, name, ...(mimeType ? { mimeType } : {}) });
    }
    if (attachments.length) msg.attachments = attachments;
    if (msg.meta?.hasAttachments && attachments.length === 0) msg.text += "\n[Email attachments could not be retrieved.]";
    if (metadata.length > INBOUND_ATTACHMENT_LIMIT) msg.text += `\n[Only the first ${INBOUND_ATTACHMENT_LIMIT} email attachments are included.]`;
  }

  private async downloadAttachments(msg: InboundMessage): Promise<void> {
    const dir = this.opts.mediaDir!;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const saved: NonNullable<InboundMessage["attachments"]> = [];
    const attachments = msg.attachments ?? [];
    for (const attachment of attachments.slice(0, INBOUND_ATTACHMENT_LIMIT)) {
      if (!attachment.url || attachment.path) {
        saved.push(attachment);
        continue;
      }
      try {
        const fetched = await fetchPublic(this.opts.fetchImpl ?? fetch, attachment.url, {
          signal: AbortSignal.timeout(20_000),
          headers: { accept: "*/*" },
          ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
        });
        if (!fetched.ok) throw new Error("The attachment URL is not available for download");
        if (!fetched.res.ok) throw new Error(`Attachment download returned HTTP ${fetched.res.status}`);
        const data = await boundedBytes(fetched.res, this.opts.maxAttachmentBytes ?? INBOUND_ATTACHMENT_BYTES);
        const hash = createHash("sha256").update(`${msg.id}\n${attachment.url}`).digest("hex");
        const path = join(dir, `${hash}${extension(attachment.mimeType, attachment.name)}`);
        await writeFile(path, data, { mode: 0o600 });
        saved.push({ ...attachment, path });
      } catch {
        // Retain the full URL and make incomplete attachment handling explicit.
        saved.push(attachment);
        msg.text += "\n[An attachment could not be downloaded; its original URL is included below.]";
      }
    }
    if (attachments.length > INBOUND_ATTACHMENT_LIMIT) msg.text += `\n[Only the first ${INBOUND_ATTACHMENT_LIMIT} attachments are included.]`;
    msg.attachments = saved;
  }
}

async function boundedBytes(res: Response, cap: number): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length")) > cap) {
    await res.body?.cancel();
    throw new Error("Attachment exceeds the download limit");
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new Error("Attachment exceeds the download limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

function extension(mimeType: string | undefined, name: string | undefined): string {
  const known: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf", "text/plain": ".txt",
    // Phone media arrives without a filename, so voice notes are named from their type alone.
    "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a", "audio/aac": ".aac", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
    "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".webm", "audio/flac": ".flac",
    "audio/amr": ".amr", "audio/3gpp": ".3gp", "audio/x-caf": ".caf",
  };
  const type = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (type && known[type]) return known[type];
  return name?.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] ?? ".bin";
}
