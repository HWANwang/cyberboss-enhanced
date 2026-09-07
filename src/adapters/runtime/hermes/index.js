const { execFile } = require("child_process");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");

const HERMES_COMMAND = process.env.CYBERBOSS_HERMES_COMMAND || "hermes";
const DEFAULT_TIMEOUT_MS = 120_000;
const HERMES_CHAT_QUIET_FLAG = "-Q";

function createHermesRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "hermes" });
  let listener = null;
  let initialized = false;

  function resolveModel(model = "") {
    return config.hermesModel || normalizeText(model);
  }

  return {
    describe() {
      return {
        id: "hermes",
        kind: "runtime",
        sessionsFile: config.sessionsFile,
        model: config.hermesModel || "",
      };
    },

    onEvent(callback) {
      if (typeof callback !== "function") {
        return () => {};
      }
      listener = callback;
      return () => {
        if (listener === callback) {
          listener = null;
        }
      };
    },

    getSessionStore() {
      return sessionStore;
    },

    getTurnCapabilities({ model = "" } = {}) {
      return {
        nativeImageInput: false,
        toolImageRead: false,
      };
    },

    async initialize() {
      if (initialized) {
        return { command: HERMES_COMMAND, models: [] };
      }
      const version = await runHermesCommand(["--version"], 10_000).catch(() => "(unknown)");
      initialized = true;
      return {
        command: HERMES_COMMAND,
        version: normalizeText(version),
        models: [],
      };
    },

    async close() {
      listener = null;
      initialized = false;
    },

    async startFreshThreadDraft({ workspaceRoot } = {}) {
      return {};
    },

    async respondApproval({ requestId, decision, result = null }) {
      // Hermes has its own approval system; we auto-accept here
      // so Cyberboss can handle approvals via its WeChat flow.
      return {
        requestId,
        ...(result && typeof result === "object"
          ? { result }
          : { decision: decision === "accept" ? "accept" : "decline" }),
      };
    },

    async cancelTurn({ threadId, turnId, workspaceRoot } = {}) {
      return { threadId, turnId };
    },

    async resumeThread({ threadId, workspaceRoot, model = "" } = {}) {
      return { threadId };
    },

    async compactThread({ threadId, workspaceRoot, model = "" } = {}) {
      return { threadId };
    },

    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" } = {}) {
      const refreshText = buildInstructionRefreshText(config);
      const turnId = `refresh-${Date.now()}`;
      // Resume the existing session so the instructions actually update the current conversation
      emitEvent("runtime.turn.started", { threadId, turnId });
      try {
        const response = await runHermesTurn({
          hermesSessionId: threadId,
          workspaceRoot,
          text: refreshText,
        });
        emitEvent("runtime.reply.completed", {
          threadId,
          turnId,
          itemId: `${turnId}-item`,
          text: response.text,
        });
        emitEvent("runtime.turn.completed", { threadId, turnId });
      } catch (error) {
        // If session expired, force-start fresh on next user message
        if (String(error.message || "").includes("Session not found")) {
          console.log(`[hermes-runtime] refresh failed: session expired for ${threadId}`);
        }
        emitEvent("runtime.turn.failed", {
          threadId,
          turnId,
          text: error.message,
        });
      }
      return { threadId };
    },

    async sendTextTurn(args) {
      return this.sendTurn(args);
    },

    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, model = "" }) {
      const turnId = `turn-${Date.now()}`;

      // Try to send the turn, with fallback for expired sessions
      const result = await this.sendTurnWithFallback({
        bindingKey, workspaceRoot, text, attachments, metadata, turnId,
      });

      return result;
    },

    async sendTurnWithFallback({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, turnId }) {
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const openingTurn = !threadId;

      const outboundText = openingTurn
        ? buildOpeningTurnText(config, text)
        : text;

      try {
        const response = await runHermesTurn({
          hermesSessionId: openingTurn ? null : threadId,
          workspaceRoot,
          text: outboundText,
          attachments,
        });

        // Track the Hermes session ID as our thread ID
        threadId = response.hermesSessionId;
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);

        // Schedule events to fire after sendTurn returns and
        // bindReplyTargetForTurn has been called by app.js.
        const finalText = normalizeSystemReplyText(outboundText, response.text);
        setTimeout(() => {
          emitEvent("runtime.turn.started", { threadId, turnId });
          emitEvent("runtime.reply.completed", {
            threadId, turnId,
            itemId: `${turnId}-item`,
            text: finalText,
          });
          emitEvent("runtime.turn.completed", { threadId, turnId });
        }, 0);

        return { threadId, turnId };
      } catch (error) {
        const errMsg = String(error.message || error);
        // If session expired, clear stale thread and retry once fresh
        if (!openingTurn && (
          errMsg.includes("Session not found") ||
          errMsg.includes("session_id:")
        )) {
          console.log(`[hermes-runtime] session expired, starting fresh: ${threadId}`);
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          return this.sendTurnWithFallback({
            bindingKey, workspaceRoot, text, attachments, metadata, turnId,
          });
        }
        if (threadId) {
          emitEvent("runtime.turn.failed", { threadId, turnId, text: errMsg });
        }
        throw error;
      }
    },
  };

  function emitEvent(type, payload = {}) {
    if (typeof listener === "function") {
      try {
        listener({ type, payload });
      } catch (err) {
        console.error(`[hermes-runtime] listener error:`, err);
      }
    }
  }
}

async function runHermesTurn({ hermesSessionId = null, workspaceRoot = null, text, attachments = [] } = {}) {
  // Build args based on whether we're resuming or starting fresh
  const args = ["-p", "cyberboss"];

  if (hermesSessionId) {
    args.push("--resume", hermesSessionId);
  }

  args.push("chat", "-q", text, HERMES_CHAT_QUIET_FLAG);

  const execOptions = {
    maxBuffer: 10 * 1024 * 1024,
    timeout: DEFAULT_TIMEOUT_MS,
  };
  if (workspaceRoot) {
    execOptions.cwd = workspaceRoot;
  }

  const result = await runHermesCommand(args, DEFAULT_TIMEOUT_MS, execOptions);
  const stdout = result.stdout;
  const stderr = result.stderr;

  // Parse output
  // The -Q (quiet) flag splits output:
  //   Fresh session: both session_id and response on STDOUT
  //   Resumed session: session_id on STDERR, response on STDOUT
  // We extract session_id from combined output and response from stdout.

  // 1. Extract session_id from combined output
  const combined = stdout + stderr;
  const sessionMatch = combined.match(/session_id:\s*(\S+)/);
  const hermesSessionIdOut = sessionMatch ? sessionMatch[1].trim() : null;

  if (!hermesSessionIdOut) {
    throw new Error(`Could not parse Hermes session ID from output`);
  }

  // 2. Extract response text from stdout (strip session_id line if present)
  let responseText = "";
  const stdoutLines = stdout.split(/\r?\n/).filter(Boolean);
  for (const line of stdoutLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("session_id:")) continue;
    if (trimmed.startsWith("↻")) continue;
    if (responseText) {
      responseText += "\n" + trimmed;
    } else {
      responseText = trimmed;
    }
  }

  if (!responseText.trim()) {
    console.warn(`[hermes] empty response for session=${hermesSessionIdOut}`);
  }

  return {
    hermesSessionId: hermesSessionIdOut,
    text: responseText.trim() || "Completed.",
  };
}

function runHermesCommand(args, timeout = DEFAULT_TIMEOUT_MS, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      HERMES_COMMAND,
      args,
      {
        ...options,
        timeout,
        env: { ...process.env, HERMES_NO_COLOR: "1" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const combined = String(stdout || "") + String(stderr || "");
        if (combined.includes("session_id:")) {
          resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
          return;
        }
        if (error) {
          if (combined.includes("Session not found")) {
            reject(new Error(`Session not found: ${combined.slice(0, 200)}`));
            return;
          }
          const message = error.killed
            ? `Hermes command timed out after ${timeout}ms`
            : `Hermes command failed: ${error.message}`;
          reject(new Error(message));
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * If the outbound text is a system message (contains SYSTEM ACTION MODE),
 * and the LLM response is plain text instead of the required JSON format,
 * auto-wrap it in send_message JSON so Cyberboss can deliver it to WeChat.
 */
function normalizeSystemReplyText(outboundText, responseText) {
  const isSystemMode = String(outboundText || "").includes("SYSTEM {");
  if (!isSystemMode) {
    return responseText;
  }
  const trimmed = String(responseText || "").trim();
  if (!trimmed) {
    return '{"action":"silent"}';
  }
  // Already valid JSON? Return as-is.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  // Plain text → wrap in send_message
  // Properly escape for JSON string value (newlines, backslashes, quotes)
  const escaped = trimmed
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `{"action":"send_message","message":"${escaped}"}`;
}

module.exports = { createHermesRuntimeAdapter };
