/**
 * Memory is two markdown files the owner can read and edit by hand:
 * memory/MEMORY.md for durable facts and memory/journal/YYYY-MM-DD.md for what
 * happened each day. The prompt builder injects `digest()`; Pi compaction keeps
 * the conversation itself small.
 */
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { StateDir } from "./state.js";

const DURABLE = "memory/MEMORY.md";
const JOURNAL_DIR = "memory/journal";
const HISTORY_DIR = "memory/history";
const REFERENCE = "memory/REFERENCE.md";
const HISTORY_KEEP = 20;

/**
 * The headings MEMORY.md is kept under. "Preferences" is special: people whose tier may know
 * the owner's preferences are shown that section and nothing else (`preferencesDigest`).
 */
export const MEMORY_SECTIONS = ["About", "People", "Preferences", "Rules", "Places and routines", "Work"] as const;

/** The owner's digest budget: about 4k tokens, so a well-kept MEMORY.md (up to ~9.6k characters) is seen whole every turn. */
export const OWNER_MEMORY_DIGEST_CHARS = 16_000;

const DURABLE_TEMPLATE = `# Memory

Durable facts about the owner, their people and their preferences. Short lines. One fact per line.
`;

/** Local calendar date, YYYY-MM-DD. The agent's VM runs in the owner's chosen TZ or UTC. */
export function journalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function timeOfDay(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function normaliseTopic(text: string): string {
  return text.toLowerCase().replace(/^\s*\d+[.)]\s*/, "").replace(/\s+/g, " ").trim();
}

function head(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return text.slice(0, cut > 0 ? cut : max).trimEnd() + "\n...";
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.indexOf("\n", text.length - max);
  return "...\n" + text.slice(start > 0 ? start + 1 : text.length - max).trimStart();
}

export class MemoryStore {
  private readonly state: StateDir;

  constructor(state: StateDir) {
    this.state = state;
  }

  readDurable(): string {
    return this.state.readText(DURABLE, "");
  }

  /** Appends a fact at the end, or at the end of a `## section` (created when missing). */
  appendDurable(text: string, section?: string): void {
    const base = this.readDurable() || DURABLE_TEMPLATE;
    const line = text.trim();
    const name = section?.trim();
    if (!name) {
      const sep = base.endsWith("\n") ? "" : "\n";
      this.state.writeText(DURABLE, `${base}${sep}${line}\n`);
      return;
    }
    const lines = base.replace(/\n+$/, "").split("\n");
    const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === name.toLowerCase());
    if (start < 0) {
      this.state.writeText(DURABLE, `${lines.join("\n")}\n\n## ${name}\n${line}\n`);
      return;
    }
    let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
    if (end < 0) end = lines.length;
    while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
    lines.splice(end, 0, line);
    this.state.writeText(DURABLE, lines.join("\n") + "\n");
  }

  replaceDurable(text: string): void {
    this.state.writeText(DURABLE, text.endsWith("\n") ? text : text + "\n");
  }

  /** Replaces MEMORY.md, keeping the previous version in memory/history/ (the newest 20). */
  rewriteDurable(text: string, now: Date = new Date()): string | undefined {
    const previous = this.readDurable();
    let saved: string | undefined;
    if (previous.trim()) {
      saved = `${HISTORY_DIR}/MEMORY-${now.toISOString().replace(/[:.]/g, "-")}.md`;
      this.state.writeText(saved, previous);
      const dir = this.state.path(HISTORY_DIR);
      const old = readdirSync(dir).filter((f) => /^MEMORY-.*\.md$/.test(f)).sort().slice(0, -HISTORY_KEEP);
      for (const f of old) rmSync(path.join(dir, f), { force: true });
    }
    this.replaceDurable(text);
    return saved;
  }

  journalPath(date: Date = new Date()): string {
    return `${JOURNAL_DIR}/${journalDate(date)}.md`;
  }

  readJournal(date: Date = new Date()): string {
    return this.state.readText(this.journalPath(date), "");
  }

  appendJournal(text: string, date: Date = new Date()): void {
    const name = this.journalPath(date);
    const existing = this.state.readText(name, "");
    const lines = text
      .trim()
      .split("\n")
      .map((l, i) => (i === 0 ? `- ${timeOfDay(date)} ${l}` : `  ${l}`))
      .join("\n");
    const header = existing ? "" : `# ${journalDate(date)}\n\n`;
    this.state.writeText(name, `${existing}${header}${lines}\n`);
  }

  /**
   * The owner's preferences only: the body of a `## Preferences` heading in MEMORY.md
   * (case-insensitive, any heading level), up to `maxChars`. Non-owners who may know the
   * owner's preferences get this and nothing else from memory. Returns "" when there is no
   * such section, so an unstructured MEMORY.md never leaks.
   */
  preferencesDigest(maxChars = 1500): string {
    const durable = this.readDurable();
    const match = /^(#{1,6})\s*preferences\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(durable);
    const body = match?.[2]?.trim() ?? "";
    if (!body) return "";
    return head(body, maxChars);
  }

  /** memory/REFERENCE.md: longer background the owner keeps by hand, read a section at a time. */
  readReference(): string {
    return this.state.readText(REFERENCE, "");
  }

  /** The `## ` headings of the reference notes, in order. */
  referenceTopics(): string[] {
    return [...this.readReference().matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
  }

  /** The reference section whose heading contains `topic` (case and numbering ignored). */
  referenceSection(topic: string): string | undefined {
    const want = normaliseTopic(topic);
    if (!want) return undefined;
    const sections = this.readReference().split(/^(?=##\s)/m).filter((s) => s.startsWith("## "));
    const heading = (s: string) => normaliseTopic(s.slice(3, s.indexOf("\n") < 0 ? undefined : s.indexOf("\n")));
    const hit = sections.find((s) => heading(s) === want) ?? sections.find((s) => heading(s).includes(want));
    return hit?.replace(/\n-{3,}\s*$/, "").trim();
  }

  /**
   * What the model sees every turn: the start of MEMORY.md, the reference topics, and the
   * end of the last two days of journal. The budget is split 60/25/15 so durable facts win.
   */
  digest(maxChars = 4000, now: Date = new Date()): string {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const durable = this.readDurable().trim();
    const today = this.readJournal(now).trim();
    const prior = this.readJournal(yesterday).trim();
    const topics = this.referenceTopics();
    const parts: string[] = [];
    const durableBudget = Math.floor(maxChars * 0.6);
    if (durable) {
      parts.push(head(durable, durableBudget));
      if (durable.length > durableBudget) parts.push("(Memory is longer than shown here. Tidy it: memory_read, then memory_rewrite with duplicates merged and stale lines removed.)");
    }
    if (topics.length) parts.push(`## Reference notes\nRead one with memory_read (section "reference", topic) when a task touches it: ${topics.join("; ")}.`);
    if (today) parts.push(`## Journal, today (${journalDate(now)})\n${tail(today, Math.floor(maxChars * 0.25))}`);
    if (prior) parts.push(`## Journal, yesterday (${journalDate(yesterday)})\n${tail(prior, Math.floor(maxChars * 0.15))}`);
    return parts.join("\n\n");
  }
}
