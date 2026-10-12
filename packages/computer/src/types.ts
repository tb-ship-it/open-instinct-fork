import type { RegisteredTool } from "@open-instinct/core";

/** How the server picks a desktop. See docs/ARCHITECTURE.md, "Configuration". */
export type ComputerMode = "auto" | "desktopd" | "maritime" | "browser" | "none";

/**
 * A source of computer tools. The server asks for the tools once at boot and registers them
 * in the core ToolRegistry; the backend owns the connection for the life of the process.
 */
export interface ComputerBackend {
  kind: "desktopd" | "maritime" | "browser";
  /** One line for logs and the system prompt, with no secrets. */
  describe(): string;
  /** Prompt section for this backend; the desktop guidance when absent. */
  guidance?(): string;
  tools(): Promise<RegisteredTool[]>;
  close(): Promise<void>;
}

export type Logger = (message: string) => void;
