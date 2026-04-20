import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toRecord } from "./common.js";

export const EXTENSION_ID = "pi-permission-system";

export interface PermissionSystemExtensionConfig {
  debugLog: boolean;
  permissionReviewLog: boolean;
  yoloMode: boolean;
  allowLocalEdits: boolean;
  allowWebAccess: boolean;
  allowedFetchDomains: string[];
}

export interface PermissionSystemConfigLoadResult {
  config: PermissionSystemExtensionConfig;
  created: boolean;
  warning?: string;
}

export interface PermissionSystemConfigSaveResult {
  success: boolean;
  error?: string;
}

export const DEFAULT_EXTENSION_CONFIG: PermissionSystemExtensionConfig = {
  debugLog: false,
  permissionReviewLog: true,
  yoloMode: false,
  allowLocalEdits: false,
  allowWebAccess: false,
  allowedFetchDomains: [],
};

export function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();
export const CONFIG_PATH = join(EXTENSION_ROOT, "config.json");
export const LOGS_DIR = join(EXTENSION_ROOT, "logs");
export const DEBUG_LOG_PATH = join(LOGS_DIR, `${EXTENSION_ID}-debug.jsonl`);
export const PERMISSION_REVIEW_LOG_PATH = join(LOGS_DIR, `${EXTENSION_ID}-permission-review.jsonl`);

function cloneDefaultConfig(): PermissionSystemExtensionConfig {
  return {
    debugLog: DEFAULT_EXTENSION_CONFIG.debugLog,
    permissionReviewLog: DEFAULT_EXTENSION_CONFIG.permissionReviewLog,
    yoloMode: DEFAULT_EXTENSION_CONFIG.yoloMode,
    allowLocalEdits: DEFAULT_EXTENSION_CONFIG.allowLocalEdits,
    allowWebAccess: DEFAULT_EXTENSION_CONFIG.allowWebAccess,
    allowedFetchDomains: [...DEFAULT_EXTENSION_CONFIG.allowedFetchDomains],
  };
}

function createDefaultConfigContent(): string {
  return `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`;
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

export function normalizePermissionSystemConfig(raw: unknown): PermissionSystemExtensionConfig {
  const record = toRecord(raw);
  return {
    debugLog: record.debugLog === true,
    permissionReviewLog: record.permissionReviewLog !== false,
    yoloMode: record.yoloMode === true,
    allowLocalEdits: record.allowLocalEdits === true,
    allowWebAccess: record.allowWebAccess === true,
    allowedFetchDomains: normalizeStringArray(record.allowedFetchDomains),
  };
}

function ensureConfigDirectory(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
}

export function ensurePermissionSystemConfig(configPath = CONFIG_PATH): { created: boolean; warning?: string } {
  if (existsSync(configPath)) {
    return { created: false };
  }

  try {
    ensureConfigDirectory(configPath);
    writeFileSync(configPath, createDefaultConfigContent(), "utf-8");
    return { created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      created: false,
      warning: `Failed to initialize permission-system config at '${configPath}': ${message}`,
    };
  }
}

export function loadPermissionSystemConfig(configPath = CONFIG_PATH): PermissionSystemConfigLoadResult {
  const ensureResult = ensurePermissionSystemConfig(configPath);

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const config = normalizePermissionSystemConfig(parsed);
    return {
      config,
      created: ensureResult.created,
      warning: ensureResult.warning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: cloneDefaultConfig(),
      created: ensureResult.created,
      warning: ensureResult.warning ?? `Failed to read permission-system config at '${configPath}': ${message}`,
    };
  }
}

export function savePermissionSystemConfig(
  config: PermissionSystemExtensionConfig,
  configPath = CONFIG_PATH,
): PermissionSystemConfigSaveResult {
  const normalized = normalizePermissionSystemConfig(config);
  const tmpPath = `${configPath}.tmp`;

  try {
    ensureConfigDirectory(configPath);
    writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, configPath);
    return { success: true };
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup failures.
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to save permission-system config at '${configPath}': ${message}`,
    };
  }
}

export function getPermissionSystemConfigPath(configPath = CONFIG_PATH): string {
  return configPath;
}

export function ensurePermissionSystemLogsDirectory(logsDir = LOGS_DIR): string | undefined {
  try {
    mkdirSync(logsDir, { recursive: true });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to create permission-system log directory '${logsDir}': ${message}`;
  }
}
