import { spawn } from "node:child_process";
import type { PreToolUseHookCommand, PreToolUseHookInput, PreToolUseHookResult, PreToolUseHookOutput } from "./hook-types.js";
import { toRecord } from "./common.js";

const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;

function isValidPermissionDecision(value: unknown): value is "allow" | "deny" | "ask" | "defer" {
  return value === "allow" || value === "deny" || value === "ask" || value === "defer";
}

function parseHookOutput(stdout: string): PreToolUseHookResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { decision: "defer", exitCode: 0, timedOut: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { decision: "defer", exitCode: 0, timedOut: false };
  }

  const record = toRecord(parsed);
  const hookSpecificOutput = toRecord(record.hookSpecificOutput);

  if (!isValidPermissionDecision(hookSpecificOutput.permissionDecision)) {
    return { decision: "defer", exitCode: 0, timedOut: false };
  }

  return {
    decision: hookSpecificOutput.permissionDecision,
    reason: typeof hookSpecificOutput.permissionDecisionReason === "string"
      ? hookSpecificOutput.permissionDecisionReason
      : undefined,
    updatedInput: hookSpecificOutput.updatedInput,
    additionalContext: typeof hookSpecificOutput.additionalContext === "string"
      ? hookSpecificOutput.additionalContext
      : undefined,
    exitCode: 0,
    timedOut: false,
  };
}

export function executePreToolUseHook(
  command: PreToolUseHookCommand,
  input: PreToolUseHookInput,
): Promise<PreToolUseHookResult> {
  const timeoutMs = (command.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000;
  const inputJson = JSON.stringify(input);

  return new Promise((resolve) => {
    let stdoutChunks: string[] = [];
    let stderrChunks: string[] = [];
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (result: PreToolUseHookResult) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sh", ["-c", command.command], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch {
      finish({ decision: "defer", exitCode: null, timedOut: false });
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (!settled) {
        try { child.kill("SIGTERM"); } catch {}
        finish({
          decision: "defer",
          stderr: stderrChunks.join(""),
          exitCode: null,
          timedOut: true,
        });
      }
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on("data", (chunk: any) => {
        stdoutChunks.push(String(chunk));
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: any) => {
        stderrChunks.push(String(chunk));
      });
    }

    child.on("error", () => {
      finish({ decision: "defer", exitCode: null, timedOut: false });
    });

    child.on("close", (code: number | null) => {
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");

      if (code === 0) {
        const result = parseHookOutput(stdout);
        result.stderr = stderr || undefined;
        finish(result);
        return;
      }

      if (code === 2) {
        finish({
          decision: "deny",
          reason: stderr.trim() || "Hook blocked this tool call (exit code 2)",
          stderr,
          exitCode: 2,
          timedOut: false,
        });
        return;
      }

      finish({
        decision: "defer",
        stderr,
        exitCode: code,
        timedOut: false,
      });
    });

    if (child.stdin) {
      try {
        child.stdin.write(inputJson);
        child.stdin.end();
      } catch {
        // EPIPE if the process exits before reading stdin — safe to ignore
      }
    }
  });
}
