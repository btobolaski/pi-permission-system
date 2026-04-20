import { toRecord } from "./common.js";
import type { PermissionSystemExtensionConfig } from "./extension-config.js";

const WEB_SEARCH_TOOLS = new Set(["web_search", "get_search_content"]);
const WEB_ACCESS_TOOLS = new Set(["web_search", "get_search_content", "fetch_content"]);

export function extractDomainFromUrl(input: unknown): string | null {
  const record = toRecord(input);
  const url = record.url;
  if (typeof url !== "string" || !url.trim()) {
    return null;
  }

  const trimmed = url.trim();

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    // Try prepending https:// for bare domains/paths
  }

  try {
    return new URL(`https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isWebAccessTool(toolName: string): boolean {
  return WEB_ACCESS_TOOLS.has(toolName);
}

export function shouldAllowWebSearch(
  toolName: string,
  config: PermissionSystemExtensionConfig,
): boolean {
  if (!config.allowWebAccess) {
    return false;
  }
  return WEB_SEARCH_TOOLS.has(toolName);
}

export function shouldAllowFetchForDomain(
  toolName: string,
  input: unknown,
  config: PermissionSystemExtensionConfig,
  sessionAllowedDomains: ReadonlySet<string>,
): boolean {
  if (!config.allowWebAccess) {
    return false;
  }
  if (toolName !== "fetch_content") {
    return false;
  }
  const domain = extractDomainFromUrl(input);
  if (!domain) {
    return false;
  }
  return config.allowedFetchDomains.includes(domain) || sessionAllowedDomains.has(domain);
}
