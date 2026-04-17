import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";

import { toRecord } from "./common.js";
import type { PermissionSystemExtensionConfig } from "./extension-config.js";

export function normalizePathForComparison(pathValue: string, cwd: string): string {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return "";
  }

  let normalizedPath = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  if (normalizedPath === "~") {
    normalizedPath = homedir();
  } else if (normalizedPath.startsWith("~/") || normalizedPath.startsWith("~\\")) {
    normalizedPath = join(homedir(), normalizedPath.slice(2));
  }

  const absolutePath = resolve(cwd, normalizedPath);
  const normalizedAbsolutePath = normalize(absolutePath);
  return process.platform === "win32" ? normalizedAbsolutePath.toLowerCase() : normalizedAbsolutePath;
}

export function isPathWithinDirectory(pathValue: string, directory: string): boolean {
  if (!pathValue || !directory) {
    return false;
  }

  if (pathValue === directory) {
    return true;
  }

  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return pathValue.startsWith(prefix);
}

export function extractNormalizedFilePath(input: unknown, cwd: string): string | null {
  const record = toRecord(input);
  // Claude Code uses file_path, Pi uses path
  const filePath = record.file_path ?? record.path;
  if (typeof filePath !== "string" || !filePath.trim()) {
    return null;
  }
  return normalizePathForComparison(filePath, cwd);
}

export function shouldAllowLocalEdit(
  toolName: string,
  input: unknown,
  cwd: string,
  config: PermissionSystemExtensionConfig,
): boolean {
  if (!config.allowLocalEdits) {
    return false;
  }
  if (toolName !== "edit" && toolName !== "write") {
    return false;
  }
  const normalizedPath = extractNormalizedFilePath(input, cwd);
  if (!normalizedPath) {
    return false;
  }
  const normalizedCwd = normalizePathForComparison(cwd, cwd);
  return isPathWithinDirectory(normalizedPath, normalizedCwd);
}
