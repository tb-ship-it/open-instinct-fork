/**
 * open_attachment: lets the agent look at a file someone sent it (an email attachment,
 * a photo, a PDF, a voice note) without handing out the general file tools.
 *
 * Why a separate tool: inbound attachments are saved under workspace/inbound, but the
 * Pi file tools need `files.read`, which only the owner tier holds. Email from the
 * owner's own address resolves to tier partner (a From header can be forged), so the
 * agent could see that an attachment existed and could not open it.
 *
 * The guard is narrow on purpose:
 * - only files directly under the inbound directory, after following symlinks;
 * - only names the hydrator writes: a 64-character hex hash plus an extension, which a
 *   sender can only learn from the attachment line of their own message;
 * - strangers are refused.
 *
 * What comes back per type:
 * - images and text: Pi's read tool (images arrive as image blocks, resized);
 * - PDF: text extracted with `pdftotext` (poppler-utils);
 * - audio: a transcript from an OpenAI-compatible speech-to-text endpoint, when a key is
 *   configured (INSTINCT_TRANSCRIBE_API_KEY, or GROQ_API_KEY; Groq by default).
 */
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, textResult } from "@open-instinct/core";
import type { RegisteredTool, ToolContext, ToolResultLike } from "@open-instinct/core";

const HASHED_NAME = /^[0-9a-f]{64}\.[A-Za-z0-9]{1,8}$/;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const TEXT_EXT = new Set([".txt", ".csv", ".md", ".json", ".html", ".htm", ".ics", ".vcf", ".xml", ".eml"]);
const AUDIO_EXT = new Set([".m4a", ".mp3", ".mp4", ".mpeg", ".mpga", ".ogg", ".oga", ".opus", ".wav", ".webm", ".flac", ".aac", ".amr", ".3gp"]);
/** What OpenAI-compatible transcription endpoints (Groq, OpenAI) accept. Others need converting first. */
const TRANSCRIBABLE_EXT = new Set([".m4a", ".mp3", ".mp4", ".mpeg", ".mpga", ".ogg", ".oga", ".opus", ".wav", ".webm", ".flac"]);
const PDF_TEXT_CAP = 40_000;
const AUDIO_MAX_BYTES = 25 * 1024 * 1024;

export const DEFAULT_TRANSCRIBE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_TRANSCRIBE_MODEL = "whisper-large-v3-turbo";

export interface AttachmentToolOptions {
  /** Where the hydrator saves inbound attachments (workspace/inbound). */
  inboundDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Test seam: extract text from a PDF. Default runs `pdftotext -layout <file> -`. */
  pdfToText?: (file: string) => Promise<string>;
}

const PARAMS = Type.Object({
  path: Type.String({ description: "The path from the [attachment ... path=...] line of the message." }),
});

export function attachmentTool(opts: AttachmentToolOptions): RegisteredTool {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pdfToText = opts.pdfToText ?? runPdfToText;
  return defineTool({
    name: "open_attachment",
    label: "Open attachment",
    description:
      "Open a file that was sent to you in this conversation: a photo, a PDF, a text file or a voice note. " +
      "Pass the path from its [attachment ... path=...] line. Images come back as images, PDFs as text, voice notes as a transcript.",
    parameters: PARAMS,
    meta: {
      capabilities: ["converse"],
      group: "files",
      describe: (args) => `open_attachment ${path.basename(String((args as { path?: unknown }).path ?? ""))}`,
    },
    execute: async (args: Static<typeof PARAMS>, ctx: ToolContext, signal?: AbortSignal): Promise<ToolResultLike> => {
      if (ctx.principal.tier === "stranger") return fail("Attachments from people you do not know are not opened.");
      let file: string;
      try {
        file = resolveInbound(opts.inboundDir, args.path);
      } catch (err) {
        return fail((err as Error).message);
      }
      const ext = path.extname(file).toLowerCase();
      if (IMAGE_EXT.has(ext) || TEXT_EXT.has(ext)) return readWithPi(opts.inboundDir, file, signal);
      if (ext === ".pdf") return readPdf(file, pdfToText);
      if (AUDIO_EXT.has(ext)) return transcribe(file, ext, env, fetchImpl, signal);
      return fail(`${ext || "This file type"} cannot be opened here. Ask for it as a PDF, an image or plain text.`);
    },
  });
}

/** The real path of an inbound attachment, or an error saying why it is refused. */
export function resolveInbound(inboundDir: string, requested: string): string {
  const raw = (requested ?? "").trim();
  if (!raw || raw.includes("\0")) throw new Error("`path` is empty");
  let root: string;
  try {
    root = realpathSync(path.resolve(inboundDir));
  } catch {
    throw new Error("No attachments have been received yet.");
  }
  const candidate = path.isAbsolute(raw) ? raw : path.resolve(root, path.basename(raw));
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`No attachment at ${path.basename(raw)}`);
  }
  if (path.dirname(real) !== root || !HASHED_NAME.test(path.basename(real))) {
    throw new Error("Only files sent to you in a message can be opened with this tool.");
  }
  if (!statSync(real).isFile()) throw new Error(`${path.basename(raw)} is not a file`);
  return real;
}

async function readWithPi(dir: string, file: string, signal?: AbortSignal): Promise<ToolResultLike> {
  const read = createReadTool(dir);
  const result = await read.execute(`open_attachment:${Date.now()}`, { path: file }, signal);
  return {
    content: result.content.map((block) =>
      block.type === "text" ? { type: "text" as const, text: block.text } : { type: "image" as const, data: block.data, mimeType: block.mimeType },
    ),
    ...(result.isError ? { isError: true } : {}),
  };
}

async function readPdf(file: string, pdfToText: (file: string) => Promise<string>): Promise<ToolResultLike> {
  let text: string;
  try {
    text = await pdfToText(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail("PDF reading needs poppler-utils on this machine: sudo apt install -y poppler-utils");
    return fail(`The PDF could not be read: ${(err as Error).message}`);
  }
  const trimmed = text.trim();
  if (!trimmed) return textResult("The PDF has no text layer (it is probably a scan). Ask for a photo of the pages instead.");
  const clipped = trimmed.length > PDF_TEXT_CAP ? `${trimmed.slice(0, PDF_TEXT_CAP)}\n[PDF text clipped at ${PDF_TEXT_CAP} characters.]` : trimmed;
  return textResult(`PDF text:\n${clipped}`);
}

function runPdfToText(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("pdftotext", ["-layout", file, "-"], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export function transcribeConfig(env: NodeJS.ProcessEnv): { apiKey?: string; url: string; model: string } {
  const apiKey = env.INSTINCT_TRANSCRIBE_API_KEY?.trim() || env.GROQ_API_KEY?.trim() || undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    url: (env.INSTINCT_TRANSCRIBE_URL?.trim() || DEFAULT_TRANSCRIBE_URL).replace(/\/+$/, ""),
    model: env.INSTINCT_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL,
  };
}

async function transcribe(file: string, ext: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ToolResultLike> {
  const cfg = transcribeConfig(env);
  if (!cfg.apiKey) {
    return fail("Voice notes cannot be transcribed yet: the person running this agent needs to set INSTINCT_TRANSCRIBE_API_KEY (a free Groq key works) and restart. Tell the sender in one sentence and ask them to type it.");
  }
  if (!TRANSCRIBABLE_EXT.has(ext)) return fail(`${ext} audio is not supported by the transcription service. Ask for an .m4a, .mp3 or .ogg voice note instead.`);
  const bytes = readFileSync(file);
  if (bytes.length > AUDIO_MAX_BYTES) return fail("The voice note is over 25 MB, too long to transcribe in one go.");
  const form = new FormData();
  form.append("file", new Blob([bytes]), `voice${ext}`);
  form.append("model", cfg.model);
  form.append("response_format", "json");
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: signal ?? AbortSignal.timeout(120_000),
    });
  } catch (err) {
    return fail(`The transcription service could not be reached: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    return fail(`Transcription failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const body = (await res.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  return textResult(text ? `Voice note transcript:\n${text}` : "The voice note was transcribed but contained no speech.");
}

function fail(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}
