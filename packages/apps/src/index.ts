export {
  capabilitiesForSlug,
  sensitiveCapabilitiesForSlug,
  toolkitOfSlug,
  APPS_MANAGE,
  CONTACTS_WRITE,
  CONTACTS_WRITE_PREFIXES,
  COMPOSIO_META_TOOLS,
  PAYMENT_TOOLKITS,
} from "./capabilities.js";
export {
  ComposioApps,
  APPS_STATE_FILE,
  ALL_TOOLKITS,
  OPENAI_COMPLETIONS_TOOL_LIMIT,
  composioModeFor,
  toolkitsWithoutAuthConfig,
  normalizeToolkits,
  wantsAllToolkits,
  type ComposioAppsOptions,
  type ComposioSessionMode,
  type ComposioSessionLike,
  type ComposioClientLike,
  type SessionCreateConfig,
  type McpEndpoint,
  type AppsState,
  type ToolkitStatus,
} from "./composio.js";
export {
  resolveAccounts,
  wrapAccountTool,
  ACCOUNTS_STATE_FILE,
  type AppAccount,
  type AccountsClientLike,
  type ConnectedAccountLike,
  type ExecuteResultLike,
  type ResolvedAccounts,
} from "./accounts.js";
export { appsGuidance, type AppsGuidanceOptions } from "./guidance.js";
export { appsTools, describeStatus, type AppsLike, type AppsToolDeps } from "./tools.js";
export { wrapMcpTool, wrapMcpTools, toolNameFor, describeCall, parametersFor, metaFor, TOOL_NAME_PREFIX, type McpToolSource } from "./wrap.js";

/** Toolkits a new agent starts with. */
export const DEFAULT_TOOLKITS: string[] = ["gmail", "googlecalendar", "googlecontacts"];
