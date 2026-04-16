import { toRecord, getNonEmptyString } from "./common.js";
import { compileWildcardPattern } from "./wildcard-matcher.js";
import type { PreToolUseHookCommand, PreToolUseHookMatcher } from "./hook-types.js";

const PI_TO_CLAUDE_CODE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
  skill: "Skill",
};

export function piToolNameToClaudeCode(piToolName: string, input: unknown): string {
  const normalized = piToolName.trim();

  if (normalized === "mcp") {
    return deriveMcpClaudeCodeName(input);
  }

  return PI_TO_CLAUDE_CODE_TOOL_NAMES[normalized] || normalized;
}

function deriveMcpClaudeCodeName(input: unknown): string {
  const record = toRecord(input);
  const tool = getNonEmptyString(record.tool);
  const server = getNonEmptyString(record.server);

  if (tool) {
    const colonIndex = tool.indexOf(":");
    if (colonIndex > 0 && colonIndex < tool.length - 1) {
      const parsedServer = tool.slice(0, colonIndex).trim();
      const parsedTool = tool.slice(colonIndex + 1).trim();
      if (parsedServer && parsedTool) {
        return `mcp__${parsedServer}__${parsedTool}`;
      }
    }

    if (server) {
      return `mcp__${server}__${tool}`;
    }
  }

  if (server) {
    return `mcp__${server}`;
  }

  return "mcp";
}

function parseIfField(ifValue: string): { toolName: string; pattern: string } | null {
  const match = ifValue.match(/^(\w+)\((.+)\)$/);
  if (!match) {
    return null;
  }
  return { toolName: match[1], pattern: match[2] };
}

function extractInputValueForTool(claudeCodeToolName: string, toolInput: unknown): string | null {
  const record = toRecord(toolInput);

  const upperName = claudeCodeToolName.toUpperCase();
  if (upperName === "BASH") {
    return getNonEmptyString(record.command);
  }

  if (upperName === "READ" || upperName === "WRITE" || upperName === "EDIT") {
    return getNonEmptyString(record.file_path) || getNonEmptyString(record.path);
  }

  if (upperName === "GREP") {
    return getNonEmptyString(record.path) || getNonEmptyString(record.pattern);
  }

  if (upperName === "GLOB") {
    return getNonEmptyString(record.pattern);
  }

  // Fallback: try common fields
  return getNonEmptyString(record.command)
    || getNonEmptyString(record.file_path)
    || getNonEmptyString(record.path)
    || null;
}

function matchesIfField(ifValue: string, claudeCodeToolName: string, toolInput: unknown): boolean {
  const parsed = parseIfField(ifValue);
  if (!parsed) {
    return false;
  }

  if (parsed.toolName.toUpperCase() !== claudeCodeToolName.toUpperCase()) {
    return false;
  }

  const inputValue = extractInputValueForTool(claudeCodeToolName, toolInput);
  if (!inputValue) {
    return false;
  }

  const compiled = compileWildcardPattern(parsed.pattern, true);
  return compiled.regex.test(inputValue);
}

export function findMatchingHookCommands(
  matchers: PreToolUseHookMatcher[],
  claudeCodeToolName: string,
  toolInput: unknown,
): PreToolUseHookCommand[] {
  const result: PreToolUseHookCommand[] = [];

  for (const entry of matchers) {
    if (!entry.matcherRegex.test(claudeCodeToolName)) {
      continue;
    }

    for (const hook of entry.hooks) {
      if (hook.type !== "command") {
        continue;
      }

      if (hook.if) {
        if (!matchesIfField(hook.if, claudeCodeToolName, toolInput)) {
          continue;
        }
      }

      result.push(hook);
    }
  }

  return result;
}
