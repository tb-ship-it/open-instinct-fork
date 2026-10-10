import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Principal, ToolContext } from "@open-instinct/core";
import { attachmentTool, resolveInbound, transcribeConfig } from "../src/attachments.js";

const HASH = "a".repeat(64);
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "oi-attach-"));
  const inbound = path.join(root, "workspace", "inbound");
  mkdirSync(inbound, { recursive: true });
  writeFileSync(path.join(root, "secret.txt"), "do not read");
  return { root, inbound };
}

function ctx(tier: Principal["tier"] = "partner"): ToolContext {
  return {
    principal: { kind: tier === "owner" ? "owner" : "contact", id: "p", tier, displayName: "Thom (by email, unverified)" },
    conversationKey: "email:t1",
    channel: "email",
    now: () => new Date("2026-10-10T10:00:00Z"),
  } as ToolContext;
}

async function run(tool: ReturnType<typeof attachmentTool>, p: string, c = ctx()) {
  const out = await tool.spec.execute({ path: p } as never, c, undefined as never);
  if (typeof out === "string") return { text: out, isError: false, images: 0 };
  return {
    text: out.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n"),
    images: out.content.filter((b) => b.type === "image").length,
    isError: Boolean((out as { isError?: boolean }).isError),
  };
}

describe("open_attachment", () => {
  it("is gated on converse, not files.read, so email from the owner can use it", () => {
    const { inbound } = setup();
    const tool = attachmentTool({ inboundDir: inbound, env: {} });
    expect(tool.spec.meta.capabilities).toEqual(["converse"]);
  });

  it("returns an image block for a photo", async () => {
    const { inbound } = setup();
    const file = path.join(inbound, `${HASH}.png`);
    writeFileSync(file, PNG_1PX);
    const out = await run(attachmentTool({ inboundDir: inbound, env: {} }), file);
    expect(out.isError).toBe(false);
    expect(out.images).toBe(1);
  });

  it("extracts PDF text", async () => {
    const { inbound } = setup();
    const file = path.join(inbound, `${HASH}.pdf`);
    writeFileSync(file, "%PDF-1.4");
    const tool = attachmentTool({ inboundDir: inbound, env: {}, pdfToText: async () => "Hearth: 120 x 45 cm" });
    const out = await run(tool, file);
    expect(out.text).toContain("Hearth: 120 x 45 cm");
  });

  it("says how to install poppler when pdftotext is missing", async () => {
    const { inbound } = setup();
    const file = path.join(inbound, `${HASH}.pdf`);
    writeFileSync(file, "%PDF-1.4");
    const missing = Object.assign(new Error("spawn pdftotext ENOENT"), { code: "ENOENT" });
    const tool = attachmentTool({ inboundDir: inbound, env: {}, pdfToText: async () => Promise.reject(missing) });
    const out = await run(tool, file);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("poppler-utils");
  });

  it("transcribes a voice note through the configured endpoint", async () => {
    const { inbound } = setup();
    const file = path.join(inbound, `${HASH}.m4a`);
    writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    let seen: { url: string; auth: string | null; model: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      seen = { url, auth: new Headers(init.headers).get("authorization"), model: form.get("model") };
      return new Response(JSON.stringify({ text: "Remind me to call Kris on Monday." }), { status: 200 });
    }) as unknown as typeof fetch;
    const tool = attachmentTool({ inboundDir: inbound, env: { INSTINCT_TRANSCRIBE_API_KEY: "gsk_test" }, fetchImpl });
    const out = await run(tool, file);
    expect(out.text).toContain("Remind me to call Kris on Monday.");
    expect(seen).toEqual({ url: "https://api.groq.com/openai/v1/audio/transcriptions", auth: "Bearer gsk_test", model: "whisper-large-v3-turbo" });
  });

  it("explains what is missing when no transcription key is set", async () => {
    const { inbound } = setup();
    const file = path.join(inbound, `${HASH}.ogg`);
    writeFileSync(file, Buffer.from([0]));
    const out = await run(attachmentTool({ inboundDir: inbound, env: {} }), file);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("INSTINCT_TRANSCRIBE_API_KEY");
  });

  it("refuses strangers", async () => {
    const { inbound } = setup();
    const file = path.join(inbound, `${HASH}.png`);
    writeFileSync(file, PNG_1PX);
    const out = await run(attachmentTool({ inboundDir: inbound, env: {} }), file, ctx("stranger"));
    expect(out.isError).toBe(true);
  });

  it("refuses anything outside the inbound folder or not named by the hydrator", () => {
    const { root, inbound } = setup();
    writeFileSync(path.join(inbound, "notes.txt"), "x");
    symlinkSync(path.join(root, "secret.txt"), path.join(inbound, `${"b".repeat(64)}.txt`));
    expect(() => resolveInbound(inbound, path.join(root, "secret.txt"))).toThrow(/Only files sent to you/);
    expect(() => resolveInbound(inbound, "../../secret.txt")).toThrow();
    expect(() => resolveInbound(inbound, path.join(inbound, "notes.txt"))).toThrow(/Only files sent to you/);
    expect(() => resolveInbound(inbound, path.join(inbound, `${"b".repeat(64)}.txt`))).toThrow(/Only files sent to you/);
  });

  it("defaults to Groq and accepts GROQ_API_KEY", () => {
    expect(transcribeConfig({ GROQ_API_KEY: "gsk_x" })).toEqual({ apiKey: "gsk_x", url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" });
  });
});
