import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BashFilter } from "./bash-filter.js";
import { DEFAULT_EXTENSION_CONFIG, loadPermissionSystemConfig, savePermissionSystemConfig } from "./extension-config.js";
import { piToolNameToClaudeCode, findMatchingHookCommands } from "./hook-matcher.js";
import { executePreToolUseHook } from "./hook-executor.js";
import { mergeHookDecisions, runPreToolUseHooks } from "./hook-runner.js";
import type { PreToolUseHookMatcher, PreToolUseHookResult } from "./hook-types.js";
import { createPermissionSystemLogger } from "./logging.js";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  resolvePermissionForwardingTargetSessionId,
} from "./permission-forwarding.js";
import { PermissionManager } from "./permission-manager.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "./tool-registry.js";
import { getPermissionSystemStatus } from "./status.js";
import { sanitizeAvailableToolsSection } from "./system-prompt-sanitizer.js";
import type { GlobalPermissionConfig } from "./types.js";
import { canResolveAskPermissionRequest, shouldAutoApprovePermissionState } from "./yolo-mode.js";
import {
  normalizePermissionDenialReason,
  createDeniedPermissionDecision,
  isPermissionDecisionState,
  requestPermissionDecisionFromUi,
  type PermissionDecisionUi,
} from "./permission-dialog.js";

type CreateManagerOptions = {
  mcpServerNames?: readonly string[];
};

function createManager(
  config: GlobalPermissionConfig,
  agentFiles: Record<string, string> = {},
  options: CreateManagerOptions = {},
) {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-test-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  for (const [name, content] of Object.entries(agentFiles)) {
    writeFileSync(join(agentsDir, `${name}.md`), content, "utf8");
  }

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    mcpServerNames: options.mcpServerNames,
  });

  return {
    manager,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

// Accepts raw Record instead of GlobalPermissionConfig so tests can include
// fields like `hooks` that are parsed by PermissionManager but not part of the typed config.
function createManagerFromRaw(config: Record<string, unknown>) {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-test-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const manager = new PermissionManager({ globalConfigPath, agentsDir });

  return {
    manager,
    configPath: globalConfigPath,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

const pendingAsyncTests: Promise<void>[] = [];

function runTest(name: string, testFn: () => void | Promise<void>): void {
  const result = testFn();
  if (result && typeof (result as any).then === "function") {
    pendingAsyncTests.push(
      (result as Promise<void>).then(
        () => { console.log(`[PASS] ${name}`); },
        (error: any) => { console.error(`[FAIL] ${name}`); throw error; },
      ),
    );
  } else {
    console.log(`[PASS] ${name}`);
  }
}

runTest("Permission-system extension config defaults debug off, review log on, and yolo mode off", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-"));
  const configPath = join(baseDir, "config.json");

  try {
    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, true);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, DEFAULT_EXTENSION_CONFIG);
    assert.equal(existsSync(configPath), true);

    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.debugLog, false);
    assert.equal(raw.permissionReviewLog, true);
    assert.equal(raw.yoloMode, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config loads yolo mode when explicitly enabled", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-yolo-"));
  const configPath = join(baseDir, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        debugLog: true,
        permissionReviewLog: false,
        yoloMode: true,
      }, null, 2)}\n`,
      "utf8",
    );

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, false);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, {
      debugLog: true,
      permissionReviewLog: false,
      yoloMode: true,
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config normalizes invalid persisted values back to defaults", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-invalid-"));
  const configPath = join(baseDir, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        debugLog: "true",
        permissionReviewLog: null,
        yoloMode: 1,
      }, null, 2)}\n`,
      "utf8",
    );

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, false);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, DEFAULT_EXTENSION_CONFIG);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config save persists normalized config", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-save-"));
  const configPath = join(baseDir, "config.json");

  try {
    const saved = savePermissionSystemConfig(
      {
        debugLog: true,
        permissionReviewLog: false,
        yoloMode: true,
      },
      configPath,
    );

    assert.equal(saved.success, true);

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, {
      debugLog: true,
      permissionReviewLog: false,
      yoloMode: true,
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Yolo mode only auto-approves ask-state permissions", () => {
  assert.equal(shouldAutoApprovePermissionState("ask", DEFAULT_EXTENSION_CONFIG), false);
  assert.equal(
    shouldAutoApprovePermissionState("ask", { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    true,
  );
  assert.equal(
    shouldAutoApprovePermissionState("deny", { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    false,
  );
  assert.equal(
    shouldAutoApprovePermissionState("allow", { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    false,
  );
});

runTest("Yolo mode resolves ask permissions without UI or delegation forwarding", () => {
  assert.equal(
    canResolveAskPermissionRequest({
      config: DEFAULT_EXTENSION_CONFIG,
      hasUI: false,
      isSubagent: false,
    }),
    false,
  );
  assert.equal(
    canResolveAskPermissionRequest({
      config: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      hasUI: false,
      isSubagent: false,
    }),
    true,
  );
  assert.equal(
    canResolveAskPermissionRequest({
      config: DEFAULT_EXTENSION_CONFIG,
      hasUI: false,
      isSubagent: true,
    }),
    true,
  );
});

runTest("Permission-system status is only exposed when yolo mode is enabled", () => {
  assert.equal(getPermissionSystemStatus(DEFAULT_EXTENSION_CONFIG), undefined);
  assert.equal(
    getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    "yolo",
  );
});

runTest("System prompt sanitizer removes the Available tools section and surrounding boilerplate", () => {
  const prompt = [
    "Available tools:",
    "- read: Read file contents",
    "- mcp: Discover, inspect, and call MCP tools across configured servers",
    "",
    "In addition to the tools above, you may have access to other custom tools depending on the project.",
    "",
    "Guidelines:",
    "- Use mcp for MCP discovery first: search by capability, describe one exact tool name, then call it.",
    "- Be concise in your responses",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["read", "mcp"]);

  assert.equal(result.removed, true);
  assert.equal(result.prompt.includes("Available tools:"), false);
  assert.equal(result.prompt.includes("In addition to the tools above"), false);
  assert.match(result.prompt, /Guidelines:/);
  assert.match(result.prompt, /Use mcp for MCP discovery first/i);
});

runTest("System prompt sanitizer removes denied tool guidelines while keeping global guidance", () => {
  const prompt = [
    "Guidelines:",
    "- Use task when work SHOULD be delegated to one or more specialized agents instead of handled entirely in the current session.",
    "- Use mcp for MCP discovery first: search by capability, describe one exact tool name, then call it.",
    "- Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    "- Be concise in your responses",
    "- Show file paths clearly when working with files",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["bash", "grep", "mcp"]);

  assert.equal(result.removed, true);
  assert.equal(result.prompt.includes("Use task when work SHOULD"), false);
  assert.match(result.prompt, /Use mcp for MCP discovery first/i);
  assert.match(result.prompt, /Prefer grep\/find\/ls tools over bash/i);
  assert.match(result.prompt, /Be concise in your responses/);
  assert.match(result.prompt, /Show file paths clearly when working with files/);
});

runTest("System prompt sanitizer removes inactive built-in write guidance", () => {
  const prompt = [
    "Guidelines:",
    "- Use write only for new files or complete rewrites",
    "- When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
    "- Be concise in your responses",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["read"]);

  assert.equal(result.removed, true);
  assert.equal(result.prompt.includes("Use write only for new files or complete rewrites"), false);
  assert.equal(result.prompt.includes("do NOT use cat or bash to display what you did"), false);
  assert.match(result.prompt, /Be concise in your responses/);
});

runTest("Permission-system logger respects debug toggle and keeps review log enabled by default", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-logs-"));
  const logsDir = join(baseDir, "logs");
  const debugLogPath = join(logsDir, "debug.jsonl");
  const reviewLogPath = join(logsDir, "review.jsonl");
  const config = { ...DEFAULT_EXTENSION_CONFIG };
  const logger = createPermissionSystemLogger({
    getConfig: () => config,
    debugLogPath,
    reviewLogPath,
    ensureLogsDirectory: () => {
      mkdirSync(logsDir, { recursive: true });
      return undefined;
    },
  });

  try {
    const initialDebugWarning = logger.debug("debug.disabled", { sample: true });
    const reviewWarning = logger.review("permission_request.waiting", { toolName: "write" });

    assert.equal(initialDebugWarning, undefined);
    assert.equal(reviewWarning, undefined);
    assert.equal(existsSync(debugLogPath), false);
    assert.equal(existsSync(reviewLogPath), true);
    assert.match(readFileSync(reviewLogPath, "utf8"), /permission_request\.waiting/);

    config.debugLog = true;
    const enabledDebugWarning = logger.debug("debug.enabled", { sample: true });
    assert.equal(enabledDebugWarning, undefined);
    assert.equal(existsSync(debugLogPath), true);
    assert.match(readFileSync(debugLogPath, "utf8"), /debug\.enabled/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("BashFilter uses opencode-style last-match hierarchy", () => {
  const filter = new BashFilter(
    {
      "*": "ask",
      "git *": "deny",
      "git status *": "ask",
      "git status": "allow",
    },
    "deny",
  );

  const exact = filter.check("git status");
  assert.equal(exact.state, "allow");
  assert.equal(exact.matchedPattern, "git status");

  const subcommand = filter.check("git status --short");
  assert.equal(subcommand.state, "ask");
  assert.equal(subcommand.matchedPattern, "git status *");

  const generic = filter.check("git commit -m test");
  assert.equal(generic.state, "deny");
  assert.equal(generic.matchedPattern, "git *");
});

runTest("PermissionManager canonical built-in permission checking", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "deny",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    tools: {
      read: "allow",
    },
  });

  try {
    const readResult = manager.checkPermission("read", {});
    assert.equal(readResult.state, "allow");
    assert.equal(readResult.source, "tool");

    const writeResult = manager.checkPermission("write", {});
    assert.equal(writeResult.state, "deny");
    assert.equal(writeResult.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("Bash patterns stay higher priority than tool-level bash fallback", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      bash: {
        "rm -rf *": "deny",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    bash: allow
---
`,
    },
  );

  try {
    const denied = manager.checkPermission("bash", { command: "rm -rf build" }, "reviewer");
    assert.equal(denied.state, "deny");
    assert.equal(denied.source, "bash");
    assert.equal(denied.matchedPattern, "rm -rf *");

    const fallback = manager.checkPermission("bash", { command: "echo hello" }, "reviewer");
    assert.equal(fallback.state, "allow");
    assert.equal(fallback.source, "bash");
    assert.equal(fallback.matchedPattern, undefined);
  } finally {
    cleanup();
  }
});

runTest("MCP wildcard matching uses the registered mcp tool", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "ask",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    mcp: {
      "*": "deny",
      "research_*": "ask",
      "research_query-*": "allow",
    },
  });

  try {
    const queryDocs = manager.checkPermission("mcp", { tool: "research:query-docs" });
    assert.equal(queryDocs.state, "allow");
    assert.equal(queryDocs.source, "mcp");
    assert.equal(queryDocs.matchedPattern, "research_query-*");
    assert.equal(queryDocs.target, "research_query-docs");

    const resolve = manager.checkPermission("mcp", { tool: "research:resolve-context" });
    assert.equal(resolve.state, "ask");
    assert.equal(resolve.matchedPattern, "research_*");
    assert.equal(resolve.target, "research_resolve-context");

    const unknown = manager.checkPermission("mcp", { tool: "search:provider" });
    assert.equal(unknown.state, "deny");
    assert.equal(unknown.matchedPattern, "*");
    assert.equal(unknown.target, "search_provider");
  } finally {
    cleanup();
  }
});

runTest("Arbitrary extension tools use exact-name tool permissions instead of MCP fallback", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "deny",
      bash: "ask",
      mcp: "allow",
      skills: "ask",
      special: "ask",
    },
    tools: {
      third_party_tool: "allow",
    },
    mcp: {
      "*": "deny",
    },
  });

  try {
    const allowed = manager.checkPermission("third_party_tool", {});
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.source, "tool");

    const fallback = manager.checkPermission("another_extension_tool", {});
    assert.equal(fallback.state, "deny");
    assert.equal(fallback.source, "default");
  } finally {
    cleanup();
  }
});

runTest("Skill permission matching", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "ask",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    skills: {
      "*": "ask",
      "web-*": "deny",
      "requesting-code-review": "allow",
    },
  });

  try {
    const allowed = manager.checkPermission("skill", { name: "requesting-code-review" });
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "requesting-code-review");
    assert.equal(allowed.source, "skill");

    const denied = manager.checkPermission("skill", { name: "web-design-guidelines" });
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "web-*");

    const fallback = manager.checkPermission("skill", { name: "unknown-skill" });
    assert.equal(fallback.state, "ask");
    assert.equal(fallback.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

runTest("MCP proxy tool infers server-prefixed aliases from configured server names", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      mcp: {
        "exa_*": "deny",
        exa_get_code_context_exa: "allow",
      },
    },
    {},
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission("mcp", { tool: "get_code_context_exa" });
    assert.equal(result.state, "allow");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_get_code_context_exa");
    assert.equal(result.target, "exa_get_code_context_exa");
  } finally {
    cleanup();
  }
});

runTest("MCP describe mode normalizes qualified tool names without duplicating server prefixes", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      mcp: {
        "exa_*": "deny",
        exa_web_search_exa: "allow",
      },
    },
    {},
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission("mcp", { describe: "exa:web_search_exa", server: "exa" });
    assert.equal(result.state, "allow");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_web_search_exa");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

runTest("Canonical tools map directly without legacy aliases", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "ask",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    tools: {
      find: "allow",
      ls: "deny",
    },
  });

  try {
    const findResult = manager.checkPermission("find", {});
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    const lsResult = manager.checkPermission("ls", {});
    assert.equal(lsResult.state, "deny");
    assert.equal(lsResult.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("tools.mcp acts as fallback allow for unmatched MCP targets", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    mcp: allow
---
`,
    },
  );

  try {
    const result = manager.checkPermission("mcp", { tool: "exa:web_search_exa" }, "reviewer");
    assert.equal(result.state, "allow");
    assert.equal(result.source, "tool");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

runTest("specific MCP rules override tools.mcp fallback", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    mcp: allow
  mcp:
    exa_web_search_exa: deny
---
`,
    },
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission("mcp", { tool: "web_search_exa" }, "reviewer");
    assert.equal(result.state, "deny");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_web_search_exa");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

runTest("specific MCP rules still win when tools.mcp is deny", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    mcp: deny
  mcp:
    exa_web_search_exa: allow
---
`,
    },
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const allowed = manager.checkPermission("mcp", { tool: "web_search_exa" }, "reviewer");
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.source, "mcp");
    assert.equal(allowed.matchedPattern, "exa_web_search_exa");
    assert.equal(allowed.target, "exa_web_search_exa");

    const fallback = manager.checkPermission("mcp", { tool: "other_exa" }, "reviewer");
    assert.equal(fallback.state, "deny");
    assert.equal(fallback.source, "tool");
    assert.equal(fallback.target, "exa_other_exa");
  } finally {
    cleanup();
  }
});

runTest("partial agent defaultPolicy overrides preserve global defaults", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "deny",
        mcp: "deny",
        skills: "deny",
        special: "deny",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  defaultPolicy:
    mcp: allow
---
`,
    },
  );

  try {
    const readResult = manager.checkPermission("read", {}, "reviewer");
    assert.equal(readResult.state, "deny");
    assert.equal(readResult.source, "tool");

    const mcpResult = manager.checkPermission("mcp", { tool: "exa:web_search_exa" }, "reviewer");
    assert.equal(mcpResult.state, "allow");
    assert.equal(mcpResult.source, "default");
  } finally {
    cleanup();
  }
});

runTest("Agent frontmatter canonical tools resolve correctly", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  find: allow
  ls: deny
---
`,
    },
  );

  try {
    const findResult = manager.checkPermission("find", {}, "reviewer");
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    const lsResult = manager.checkPermission("ls", {}, "reviewer");
    assert.equal(lsResult.state, "deny");
    assert.equal(lsResult.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("Only canonical built-ins support top-level shorthand in agent frontmatter", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "deny",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  find: allow
  task: allow
  mcp: allow
---
`,
    },
  );

  try {
    const findResult = manager.checkPermission("find", {}, "reviewer");
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    const taskResult = manager.checkPermission("task", {}, "reviewer");
    assert.equal(taskResult.state, "deny");
    assert.equal(taskResult.source, "default");

    const mcpResult = manager.checkPermission("mcp", { tool: "exa:web_search_exa" }, "reviewer");
    assert.equal(mcpResult.state, "deny");
    assert.equal(mcpResult.source, "default");
  } finally {
    cleanup();
  }
});

runTest("task uses exact-name tool permissions like any registered extension tool", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "allow",
        skills: "ask",
        special: "ask",
      },
      tools: {
        task: "allow",
      },
    },
  );

  try {
    const taskResult = manager.checkPermission("task", {});
    assert.equal(taskResult.state, "allow");
    assert.equal(taskResult.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("Tool registry resolves event tool names from string and object payloads", () => {
  assert.equal(getToolNameFromValue("  read  "), "read");
  assert.equal(getToolNameFromValue({ toolName: "write" }), "write");
  assert.equal(getToolNameFromValue({ name: "find" }), "find");
  assert.equal(getToolNameFromValue({ tool: "grep" }), "grep");
  assert.equal(getToolNameFromValue({}), null);
});

runTest("Tool registry blocks unregistered tools and handles aliases", () => {
  const registeredTools = [{ toolName: "mcp" }, { toolName: "read" }, { toolName: "bash" }];

  const unknownCheck = checkRequestedToolRegistration("third_party_tool", registeredTools);
  assert.equal(unknownCheck.status, "unregistered");
  if (unknownCheck.status === "unregistered") {
    assert.deepEqual(unknownCheck.availableToolNames, ["bash", "mcp", "read"]);
  }

  const aliasCheck = checkRequestedToolRegistration("legacy_read", registeredTools, { legacy_read: "read" });
  assert.equal(aliasCheck.status, "registered");

  const missingNameCheck = checkRequestedToolRegistration("   ", registeredTools);
  assert.equal(missingNameCheck.status, "missing-tool-name");
});

runTest("getToolPermission returns tool-level policy for canonical and extension tools", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    bash: deny
    read: deny
    task: allow
---
`,
    },
  );

  try {
    const bashPermission = manager.getToolPermission("bash", "reviewer");
    assert.equal(bashPermission, "deny");

    const taskPermission = manager.getToolPermission("task", "reviewer");
    assert.equal(taskPermission, "allow");

    const readPermission = manager.getToolPermission("read", "reviewer");
    assert.equal(readPermission, "deny");

    const defaultBashPermission = manager.getToolPermission("bash");
    assert.equal(defaultBashPermission, "ask");

    const { manager: manager2, cleanup: cleanup2 } = createManager({
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      tools: {
        bash: "allow",
      },
    });

    try {
      const globalBashPermission = manager2.getToolPermission("bash");
      assert.equal(globalBashPermission, "allow");
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});

runTest("getToolPermission supports arbitrary extension tool names", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "deny",
      bash: "ask",
      mcp: "allow",
      skills: "ask",
      special: "ask",
    },
    tools: {
      third_party_tool: "allow",
    },
  });

  try {
    const explicitPermission = manager.getToolPermission("third_party_tool");
    assert.equal(explicitPermission, "allow");

    const fallbackPermission = manager.getToolPermission("missing_extension_tool");
    assert.equal(fallbackPermission, "deny");
  } finally {
    cleanup();
  }
});

runTest("Yolo mode bypasses delegated ask routing when no parent forwarding target is available", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {},
  });

  assert.equal(targetSessionId, null);
  assert.equal(
    canResolveAskPermissionRequest({
      config: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      hasUI: false,
      isSubagent: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoApprovePermissionState("ask", { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    true,
  );
});

runTest("Permission forwarding resolves the parent interactive session from subagent runtime env", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {
      PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-session",
    },
  });

  assert.equal(targetSessionId, "parent-session");
});

runTest("Permission forwarding does not guess a target session when subagent runtime env is missing", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {},
  });

  assert.equal(targetSessionId, null);
});

runTest("Permission forwarding uses session-scoped directories per interactive session", () => {
  const forwardingRoot = join(tmpdir(), "pi-permission-system-forwarding-root");
  const sessionA = createPermissionForwardingLocation(forwardingRoot, "session-a");
  const sessionB = createPermissionForwardingLocation(forwardingRoot, "session-b");

  assert.notEqual(sessionA.sessionRootDir, sessionB.sessionRootDir);
  assert.notEqual(sessionA.requestsDir, sessionB.requestsDir);
  assert.notEqual(sessionA.responsesDir, sessionB.responsesDir);
});

runTest("Permission forwarding request routing only matches the intended UI session", () => {
  assert.equal(
    isForwardedPermissionRequestForSession({ targetSessionId: "session-a" }, "session-a"),
    true,
  );
  assert.equal(
    isForwardedPermissionRequestForSession({ targetSessionId: "session-a" }, "session-b"),
    false,
  );
});

runTest("Permission forwarding rejects unresolved sentinel session ids", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: true,
    isSubagent: false,
    currentSessionId: "unknown",
  });

  assert.equal(targetSessionId, null);
});

// --- PreToolUse Hook Tests ---

function hookMatcher(matcher: string, hooks: any[]): PreToolUseHookMatcher {
  return { matcher, matcherRegex: new RegExp(`^(?:${matcher})$`), hooks };
}

runTest("piToolNameToClaudeCode maps Pi built-in tool names to Claude Code convention", () => {
  assert.equal(piToolNameToClaudeCode("bash", {}), "Bash");
  assert.equal(piToolNameToClaudeCode("read", {}), "Read");
  assert.equal(piToolNameToClaudeCode("write", {}), "Write");
  assert.equal(piToolNameToClaudeCode("edit", {}), "Edit");
  assert.equal(piToolNameToClaudeCode("grep", {}), "Grep");
  assert.equal(piToolNameToClaudeCode("find", {}), "Glob");
  assert.equal(piToolNameToClaudeCode("ls", {}), "LS");
  assert.equal(piToolNameToClaudeCode("skill", {}), "Skill");
});

runTest("piToolNameToClaudeCode passes through unknown tool names unchanged", () => {
  assert.equal(piToolNameToClaudeCode("task", {}), "task");
  assert.equal(piToolNameToClaudeCode("custom_tool", {}), "custom_tool");
});

runTest("piToolNameToClaudeCode derives mcp__server__tool from MCP input", () => {
  assert.equal(
    piToolNameToClaudeCode("mcp", { tool: "exa:search" }),
    "mcp__exa__search",
  );
  assert.equal(
    piToolNameToClaudeCode("mcp", { tool: "git-read-only:status", server: "git-read-only" }),
    "mcp__git-read-only__status",
  );
  assert.equal(
    piToolNameToClaudeCode("mcp", { tool: "search", server: "exa" }),
    "mcp__exa__search",
  );
  assert.equal(piToolNameToClaudeCode("mcp", { server: "exa" }), "mcp__exa");
  assert.equal(piToolNameToClaudeCode("mcp", {}), "mcp");
});

runTest("findMatchingHookCommands matches on regex matcher field", () => {
  const matchers: PreToolUseHookMatcher[] = [
    hookMatcher("Bash", [{ type: "command", command: "echo bash" }]),
    hookMatcher("Read|Write", [{ type: "command", command: "echo rw" }]),
  ];

  const bashMatches = findMatchingHookCommands(matchers, "Bash", {});
  assert.equal(bashMatches.length, 1);
  assert.equal(bashMatches[0].command, "echo bash");

  const readMatches = findMatchingHookCommands(matchers, "Read", {});
  assert.equal(readMatches.length, 1);
  assert.equal(readMatches[0].command, "echo rw");

  const grepMatches = findMatchingHookCommands(matchers, "Grep", {});
  assert.equal(grepMatches.length, 0);
});

runTest("findMatchingHookCommands supports wildcard matchers", () => {
  const matchers: PreToolUseHookMatcher[] = [
    hookMatcher(".*", [{ type: "command", command: "echo all" }]),
    hookMatcher("mcp__exa__.*", [{ type: "command", command: "echo exa" }]),
  ];

  const bashMatches = findMatchingHookCommands(matchers, "Bash", {});
  assert.equal(bashMatches.length, 1);
  assert.equal(bashMatches[0].command, "echo all");

  const exaMatches = findMatchingHookCommands(matchers, "mcp__exa__search", {});
  assert.equal(exaMatches.length, 2);
});

runTest("findMatchingHookCommands filters by if field", () => {
  const matchers: PreToolUseHookMatcher[] = [
    hookMatcher("Bash", [
      { type: "command", if: "Bash(rm *)", command: "echo block-rm" },
      { type: "command", command: "echo allow-all" },
    ]),
  ];

  const rmMatches = findMatchingHookCommands(matchers, "Bash", { command: "rm -rf /tmp" });
  assert.equal(rmMatches.length, 2);
  assert.equal(rmMatches[0].command, "echo block-rm");
  assert.equal(rmMatches[1].command, "echo allow-all");

  const lsMatches = findMatchingHookCommands(matchers, "Bash", { command: "ls" });
  assert.equal(lsMatches.length, 1);
  assert.equal(lsMatches[0].command, "echo allow-all");
});

runTest("findMatchingHookCommands if field checks tool name match", () => {
  const matchers: PreToolUseHookMatcher[] = [
    hookMatcher(".*", [
      { type: "command", if: "Bash(rm *)", command: "echo block-rm" },
    ]),
  ];

  // Matcher regex matches Read, but the if field specifies Bash — should not match
  const readMatches = findMatchingHookCommands(matchers, "Read", { path: "rm -rf" });
  assert.equal(readMatches.length, 0);
});

runTest("findMatchingHookCommands if field works for Edit file paths", () => {
  const matchers: PreToolUseHookMatcher[] = [
    hookMatcher("Edit", [
      { type: "command", if: "Edit(*.ts)", command: "echo ts-only" },
    ]),
  ];

  const tsMatches = findMatchingHookCommands(matchers, "Edit", { file_path: "src/index.ts" });
  assert.equal(tsMatches.length, 1);

  const jsMatches = findMatchingHookCommands(matchers, "Edit", { file_path: "src/index.js" });
  assert.equal(jsMatches.length, 0);
});

runTest("mergeHookDecisions returns defer for empty results", () => {
  const merged = mergeHookDecisions([]);
  assert.equal(merged.decision, "defer");
  assert.deepEqual(merged.reasons, []);
});

runTest("mergeHookDecisions picks highest-priority decision", () => {
  const allowAllow = mergeHookDecisions([
    { decision: "allow", exitCode: 0, timedOut: false },
    { decision: "allow", exitCode: 0, timedOut: false },
  ]);
  assert.equal(allowAllow.decision, "allow");

  const allowDeny = mergeHookDecisions([
    { decision: "allow", exitCode: 0, timedOut: false },
    { decision: "deny", reason: "blocked", exitCode: 0, timedOut: false },
  ]);
  assert.equal(allowDeny.decision, "deny");

  const askAllow = mergeHookDecisions([
    { decision: "ask", reason: "needs review", exitCode: 0, timedOut: false },
    { decision: "allow", exitCode: 0, timedOut: false },
  ]);
  assert.equal(askAllow.decision, "ask");

  const deferAsk = mergeHookDecisions([
    { decision: "defer", exitCode: 0, timedOut: false },
    { decision: "ask", reason: "needs review", exitCode: 0, timedOut: false },
  ]);
  assert.equal(deferAsk.decision, "ask");
});

runTest("mergeHookDecisions aggregates reasons from all results", () => {
  const merged = mergeHookDecisions([
    { decision: "ask", reason: "reason-a", exitCode: 0, timedOut: false },
    { decision: "deny", reason: "reason-b", exitCode: 0, timedOut: false },
  ]);
  assert.equal(merged.decision, "deny");
  assert.deepEqual(merged.reasons, ["reason-a", "reason-b"]);
});

runTest("mergeHookDecisions forwards updatedInput and additionalContext from winner", () => {
  const merged = mergeHookDecisions([
    { decision: "deny", reason: "blocked", updatedInput: { x: 1 }, additionalContext: "ctx", exitCode: 0, timedOut: false },
    { decision: "allow", updatedInput: { y: 2 }, exitCode: 0, timedOut: false },
  ]);
  assert.equal(merged.decision, "deny");
  assert.deepEqual(merged.updatedInput, { x: 1 });
  assert.equal(merged.additionalContext, "ctx");
});

runTest("mergeHookDecisions does not inherit updatedInput from lower-priority result", () => {
  const merged = mergeHookDecisions([
    { decision: "deny", reason: "blocked", exitCode: 0, timedOut: false },
    { decision: "allow", updatedInput: { y: 2 }, additionalContext: "ignored", exitCode: 0, timedOut: false },
  ]);
  assert.equal(merged.decision, "deny");
  assert.equal(merged.updatedInput, undefined);
  assert.equal(merged.additionalContext, undefined);
});

function createTempScript(dir: string, name: string, content: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

runTest("executePreToolUseHook parses valid JSON deny output on exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "deny.sh", `#!/bin/sh
cat <<'JSON'
{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked by policy"}}
JSON
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "blocked by policy");
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook parses allow decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "allow.sh", `#!/bin/sh
echo '{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"safe command"}}'
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "allow");
    assert.equal(result.reason, "safe command");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook returns deny with stderr on exit code 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "exit2.sh", `#!/bin/sh
echo "danger zone" >&2
exit 2
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "danger zone");
    assert.ok(result.stderr?.includes("danger zone"));
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook returns defer on non-zero non-2 exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "exit1.sh", `#!/bin/sh
exit 1
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "defer");
    assert.equal(result.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook returns defer on invalid JSON output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "bad-json.sh", `#!/bin/sh
echo "not json"
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "defer");
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook returns defer on empty stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "empty.sh", `#!/bin/sh
exit 0
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "defer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook defers on unrecognized permissionDecision value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "maybe.sh", `#!/bin/sh
echo '{"hookSpecificOutput":{"permissionDecision":"maybe","permissionDecisionReason":"unsure"}}'
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "defer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook enforces timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "slow.sh", `#!/bin/sh
sleep 30
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script, timeout: 1 },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "defer");
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook receives tool input on stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    // Script reads stdin and checks tool_name field, denies if it matches
    const script = createTempScript(dir, "stdin-check.sh", `#!/bin/sh
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$TOOL_NAME" = "Bash" ]; then
  echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"received bash"}}'
else
  echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'
fi
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "received bash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook sends transcript_path in stdin JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "check-transcript.sh", `#!/bin/sh
INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | grep -o '"transcript_path":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$TRANSCRIPT" = "/some/session/dir" ]; then
  echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'
else
  echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"missing or wrong transcript_path"}}'
fi
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "/some/session/dir" },
    );
    assert.equal(result.decision, "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("runPreToolUseHooks propagates transcript_path to hook subprocess", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "check-ctx-transcript.sh", `#!/bin/sh
INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | grep -o '"transcript_path":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$TRANSCRIPT" = "/ctx/session/dir" ]; then
  echo '{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"transcript_path received"}}'
else
  echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"missing transcript_path"}}'
fi
`);
    const matchers: PreToolUseHookMatcher[] = [
      hookMatcher("Bash", [{ type: "command", command: script }]),
    ];
    const ctx = { session_id: "test", cwd: "/tmp", permission_mode: "default", transcript_path: "/ctx/session/dir" };

    const result = await runPreToolUseHooks(matchers, "bash", { command: "ls" }, ctx, "id-1");
    assert.equal(result.decision, "allow");
    assert.ok(result.reasons.some((r) => r.includes("transcript_path received")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("runPreToolUseHooks returns defer when no hooks match", async () => {
  const matchers: PreToolUseHookMatcher[] = [
    hookMatcher("Bash", [{ type: "command", command: "echo ignored" }]),
  ];

  const result = await runPreToolUseHooks(matchers, "read", {}, {
    session_id: "test", cwd: "/tmp", permission_mode: "default", transcript_path: "",
  }, "test-id");

  assert.equal(result.decision, "defer");
});

runTest("runPreToolUseHooks executes matching hooks end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "deny-rm.sh", `#!/bin/sh
INPUT=$(cat)
CMD=$(echo "$INPUT" | grep -o '"command":"[^"]*"' | head -1 | cut -d'"' -f4)
case "$CMD" in
  rm*)
    echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"rm blocked"}}'
    ;;
  *)
    echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'
    ;;
esac
`);
    const matchers: PreToolUseHookMatcher[] = [
      hookMatcher("Bash", [{ type: "command", command: script }]),
    ];
    const ctx = { session_id: "test", cwd: "/tmp", permission_mode: "default", transcript_path: "" };

    const rmResult = await runPreToolUseHooks(matchers, "bash", { command: "rm -rf /tmp/foo" }, ctx, "id-1");
    assert.equal(rmResult.decision, "deny");
    assert.ok(rmResult.reasons.some((r) => r.includes("rm blocked")));

    const lsResult = await runPreToolUseHooks(matchers, "bash", { command: "ls" }, ctx, "id-2");
    assert.equal(lsResult.decision, "allow");

    // Read tool should not match the Bash-only hook
    const readResult = await runPreToolUseHooks(matchers, "read", { path: "/tmp" }, ctx, "id-3");
    assert.equal(readResult.decision, "defer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("PermissionManager.getHooks parses hooks from pi-permissions.jsonc", () => {
  const { manager, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "/usr/local/bin/check.sh", timeout: 5 },
            { type: "command", if: "Bash(rm *)", command: "/usr/local/bin/block-rm.sh" },
          ],
        },
      ],
    },
  });
  try {
    const hooks = manager.getHooks();
    assert.ok(hooks);
    assert.ok(hooks!.PreToolUse);
    assert.equal(hooks!.PreToolUse!.length, 1);
    assert.equal(hooks!.PreToolUse![0].matcher, "Bash");
    assert.equal(hooks!.PreToolUse![0].hooks.length, 2);
    assert.equal(hooks!.PreToolUse![0].hooks[0].timeout, 5);
    assert.equal(hooks!.PreToolUse![0].hooks[1].if, "Bash(rm *)");
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks drops invalid hook entries", () => {
  const { manager, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "" }] },
        { matcher: "", hooks: [{ type: "command", command: "echo x" }] },
        { matcher: "Bash", hooks: [] },
        { matcher: "Read", hooks: [{ type: "not-command", command: "echo y" }] },
        "not-an-object",
      ],
    },
  });
  try {
    assert.equal(manager.getHooks(), undefined);
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks preserves valid entries when some are invalid", () => {
  const { manager, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo valid" }] },
        { matcher: "", hooks: [{ type: "command", command: "echo invalid-empty-matcher" }] },
      ],
    },
  });
  try {
    const hooks = manager.getHooks();
    assert.ok(hooks);
    assert.equal(hooks!.PreToolUse!.length, 1);
    assert.equal(hooks!.PreToolUse![0].matcher, "Bash");
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks rejects invalid regex in matcher", () => {
  const { manager, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    hooks: {
      PreToolUse: [
        { matcher: "[invalid", hooks: [{ type: "command", command: "echo bad" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "echo good" }] },
      ],
    },
  });
  try {
    const hooks = manager.getHooks();
    assert.ok(hooks);
    assert.equal(hooks!.PreToolUse!.length, 1);
    assert.equal(hooks!.PreToolUse![0].matcher, "Bash");
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks rejects timeout of zero", () => {
  const { manager, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo x", timeout: 0 }] },
      ],
    },
  });
  try {
    const hooks = manager.getHooks();
    assert.ok(hooks);
    assert.equal(hooks!.PreToolUse![0].hooks[0].timeout, undefined);
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks rejects negative timeout", () => {
  const { manager, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo x", timeout: -1 }] },
      ],
    },
  });
  try {
    const hooks = manager.getHooks();
    assert.ok(hooks);
    assert.equal(hooks!.PreToolUse![0].hooks[0].timeout, undefined);
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks rejects non-numeric timeout", () => {
  const { manager, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo x", timeout: "5" }] },
      ],
    },
  });
  try {
    const hooks = manager.getHooks();
    assert.ok(hooks);
    assert.equal(hooks!.PreToolUse![0].hooks[0].timeout, undefined);
  } finally {
    cleanup();
  }
});

runTest("findMatchingHookCommands skips hooks with malformed if fields", () => {
  const matchers: PreToolUseHookMatcher[] = [
    hookMatcher("Bash", [
      { type: "command", if: "NoParen", command: "echo bad" },
      { type: "command", if: "()", command: "echo bad2" },
      { type: "command", command: "echo good" },
    ]),
  ];
  const result = findMatchingHookCommands(matchers, "Bash", { command: "ls" });
  assert.equal(result.length, 1);
  assert.equal(result[0].command, "echo good");
});

runTest("piToolNameToClaudeCode handles MCP colon boundary cases", () => {
  assert.equal(piToolNameToClaudeCode("mcp", { tool: ":search" }), "mcp");
  assert.equal(piToolNameToClaudeCode("mcp", { tool: "exa:" }), "mcp");
  assert.equal(piToolNameToClaudeCode("mcp", { tool: ":" }), "mcp");
});

runTest("executePreToolUseHook uses fallback reason when stderr is empty on exit 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "exit2-no-stderr.sh", `#!/bin/sh
exit 2
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "Hook blocked this tool call (exit code 2)");
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("executePreToolUseHook defers when command does not exist", async () => {
  const result = await executePreToolUseHook(
    { type: "command", command: "/nonexistent/path/to/hook-that-does-not-exist.sh" },
    { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
  );
  assert.equal(result.decision, "defer");
  assert.equal(result.timedOut, false);
  assert.notEqual(result.exitCode, 0);
});

runTest("executePreToolUseHook parses updatedInput and additionalContext fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "modified.sh", `#!/bin/sh
echo '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"safe-cmd"},"additionalContext":"extra info"}}'
`);
    const result = await executePreToolUseHook(
      { type: "command", command: script },
      { session_id: "test", cwd: "/tmp", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "test-id", transcript_path: "" },
    );
    assert.equal(result.decision, "allow");
    assert.deepEqual(result.updatedInput, { command: "safe-cmd" });
    assert.equal(result.additionalContext, "extra info");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("runPreToolUseHooks merges conflicting decisions from multiple hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const allowScript = createTempScript(dir, "allow.sh", `#!/bin/sh
echo '{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"looks safe"}}'
`);
    const denyScript = createTempScript(dir, "deny.sh", `#!/bin/sh
echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked by audit"}}'
`);
    const matchers: PreToolUseHookMatcher[] = [
      hookMatcher("Bash", [
        { type: "command", command: allowScript },
        { type: "command", command: denyScript },
      ]),
    ];
    const ctx = { session_id: "test", cwd: "/tmp", permission_mode: "default", transcript_path: "" };
    const result = await runPreToolUseHooks(matchers, "bash", { command: "ls" }, ctx, "id-1");
    assert.equal(result.decision, "deny");
    assert.ok(result.reasons.some((r) => r.includes("blocked by audit")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("runPreToolUseHooks forwards updatedInput and additionalContext from hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  try {
    const script = createTempScript(dir, "modify.sh", `#!/bin/sh
echo '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"safe"},"additionalContext":"extra"}}'
`);
    const matchers: PreToolUseHookMatcher[] = [
      hookMatcher("Bash", [{ type: "command", command: script }]),
    ];
    const ctx = { session_id: "test", cwd: "/tmp", permission_mode: "default", transcript_path: "" };
    const result = await runPreToolUseHooks(matchers, "bash", { command: "ls" }, ctx, "id-1");
    assert.equal(result.decision, "allow");
    assert.deepEqual(result.updatedInput, { command: "safe" });
    assert.equal(result.additionalContext, "extra");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest("PermissionManager.getHooks returns undefined when no hooks configured", () => {
  const { manager, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
  });
  try {
    assert.equal(manager.getHooks(), undefined);
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks invalidates cache when file changes", () => {
  const { manager, configPath, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo first" }] },
      ],
    },
  });
  try {
    const first = manager.getHooks();
    assert.ok(first);
    assert.equal(first!.PreToolUse![0].hooks[0].command, "echo first");

    writeFileSync(configPath, JSON.stringify({
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: "echo second" }] },
        ],
      },
    }, null, 2) + "\n", "utf8");

    const second = manager.getHooks();
    assert.ok(second);
    assert.equal(second!.PreToolUse![0].matcher, "Read");
    assert.equal(second!.PreToolUse![0].hooks[0].command, "echo second");
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks returns undefined for corrupt config file", () => {
  const { manager, configPath, cleanup } = createManagerFromRaw({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
  });
  try {
    writeFileSync(configPath, "this is not valid json {{{", "utf8");
    assert.equal(manager.getHooks(), undefined);
  } finally {
    cleanup();
  }
});

runTest("PermissionManager.getHooks parses hooks with JSONC comments", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-test-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  writeFileSync(globalConfigPath, `{
  "defaultPolicy": { "tools": "ask", "bash": "ask", "mcp": "ask", "skills": "ask", "special": "ask" },
  // Hook configuration
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        /* block dangerous commands */
        "hooks": [{ "type": "command", "command": "echo guarded" }]
      }
    ]
  }
}
`, "utf8");

  const manager = new PermissionManager({ globalConfigPath, agentsDir });
  try {
    const hooks = manager.getHooks();
    assert.ok(hooks);
    assert.equal(hooks!.PreToolUse![0].matcher, "Bash");
    assert.equal(hooks!.PreToolUse![0].hooks[0].command, "echo guarded");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- Permission dialog tests ---

runTest("normalizePermissionDenialReason returns undefined for non-string inputs", () => {
  assert.equal(normalizePermissionDenialReason(undefined), undefined);
  assert.equal(normalizePermissionDenialReason(null), undefined);
  assert.equal(normalizePermissionDenialReason(42), undefined);
  assert.equal(normalizePermissionDenialReason({}), undefined);
});

runTest("normalizePermissionDenialReason returns undefined for empty and whitespace-only strings", () => {
  assert.equal(normalizePermissionDenialReason(""), undefined);
  assert.equal(normalizePermissionDenialReason("   "), undefined);
  assert.equal(normalizePermissionDenialReason("\t\n"), undefined);
});

runTest("normalizePermissionDenialReason trims and returns non-empty strings", () => {
  assert.equal(normalizePermissionDenialReason("reason"), "reason");
  assert.equal(normalizePermissionDenialReason("  reason  "), "reason");
});

runTest("createDeniedPermissionDecision returns plain denied when no reason given", () => {
  const result = createDeniedPermissionDecision();
  assert.equal(result.approved, false);
  assert.equal(result.state, "denied");
  assert.equal(result.denialReason, undefined);
});

runTest("createDeniedPermissionDecision returns plain denied for empty reason", () => {
  const result = createDeniedPermissionDecision("");
  assert.equal(result.approved, false);
  assert.equal(result.state, "denied");
  assert.equal(result.denialReason, undefined);
});

runTest("createDeniedPermissionDecision returns denied_with_reason for non-empty reason", () => {
  const result = createDeniedPermissionDecision("too risky");
  assert.equal(result.approved, false);
  assert.equal(result.state, "denied_with_reason");
  assert.equal(result.denialReason, "too risky");
});

runTest("createDeniedPermissionDecision normalizes whitespace-only reason to plain denied", () => {
  const result = createDeniedPermissionDecision("   ");
  assert.equal(result.approved, false);
  assert.equal(result.state, "denied");
  assert.equal(result.denialReason, undefined);
});

runTest("isPermissionDecisionState accepts valid states", () => {
  assert.equal(isPermissionDecisionState("approved"), true);
  assert.equal(isPermissionDecisionState("denied"), true);
  assert.equal(isPermissionDecisionState("denied_with_reason"), true);
});

runTest("isPermissionDecisionState rejects invalid values", () => {
  assert.equal(isPermissionDecisionState("unknown"), false);
  assert.equal(isPermissionDecisionState(""), false);
  assert.equal(isPermissionDecisionState(null), false);
  assert.equal(isPermissionDecisionState(undefined), false);
});

runTest("requestPermissionDecisionFromUi returns approved when user selects Yes", async () => {
  const ui: PermissionDecisionUi = {
    select: async () => "Yes",
    input: async () => { throw new Error("should not be called"); },
  };
  const result = await requestPermissionDecisionFromUi(ui, "title", "message");
  assert.equal(result.approved, true);
  assert.equal(result.state, "approved");
});

runTest("requestPermissionDecisionFromUi returns denied when user selects No", async () => {
  const ui: PermissionDecisionUi = {
    select: async () => "No",
    input: async () => { throw new Error("should not be called"); },
  };
  const result = await requestPermissionDecisionFromUi(ui, "title", "message");
  assert.equal(result.approved, false);
  assert.equal(result.state, "denied");
  assert.equal(result.denialReason, undefined);
});

runTest("requestPermissionDecisionFromUi returns denied_with_reason when user provides a reason", async () => {
  const ui: PermissionDecisionUi = {
    select: async () => "No, provide reason",
    input: async () => "too dangerous",
  };
  const result = await requestPermissionDecisionFromUi(ui, "title", "message");
  assert.equal(result.approved, false);
  assert.equal(result.state, "denied_with_reason");
  assert.equal(result.denialReason, "too dangerous");
});

runTest("requestPermissionDecisionFromUi returns plain denied when reason input is empty", async () => {
  const ui: PermissionDecisionUi = {
    select: async () => "No, provide reason",
    input: async () => "",
  };
  const result = await requestPermissionDecisionFromUi(ui, "title", "message");
  assert.equal(result.approved, false);
  assert.equal(result.state, "denied");
  assert.equal(result.denialReason, undefined);
});

runTest("requestPermissionDecisionFromUi returns denied when select is dismissed", async () => {
  const ui: PermissionDecisionUi = {
    select: async () => undefined,
    input: async () => { throw new Error("should not be called"); },
  };
  const result = await requestPermissionDecisionFromUi(ui, "title", "message");
  assert.equal(result.approved, false);
  assert.equal(result.state, "denied");
});

await Promise.all(pendingAsyncTests);
console.log("All permission system tests passed.");
