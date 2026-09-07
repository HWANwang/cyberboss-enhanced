const { CodexRpcClient } = require("./rpc-client");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { mapCodexMessageToRuntimeEvent } = require("./events");
const {
  extractAssistantText,
  extractFailureText,
  extractThreadId,
  extractTurnId,
  extractThreadIdFromParams,
  extractTurnIdFromParams,
  isAssistantItemCompleted,
} = require("./message-utils");
const { findModelByQuery } = require("./model-catalog");
const { SessionStore } = require("./session-store");
const { resolveCodexProjectToolMcpServerConfig } = require("./mcp-config");

function createCodexRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "codex" });
  let client = null;
  let readyState = null;
  const eventListeners = new Set();
  const configuredModel = normalizeText(config.codexModel);
  const configuredModelProvider = normalizeText(config.codexModelProvider);

  function resolveModel(model = "", storedParams = null) {
    // 1) explicit runtime override (set via the WeChat /model command) wins
    if (storedParams && normalizeText(storedParams.model)) {
      return normalizeText(storedParams.model);
    }
    // 2) configured default from .env
    if (configuredModel) {
      return configuredModel;
    }
    // 3) whatever the caller suggested
    return normalizeText(model);
  }

  function ensureClient() {
    if (!client) {
      client = new CodexRpcClient({
        endpoint: config.codexEndpoint,
        codexCommand: config.codexCommand,
        env: process.env,
        extraWritableRoots: [config.stateDir],
        mcpServerConfig: resolveCodexProjectToolMcpServerConfig(),
      });
    }
    return client;
  }

  return {
    describe() {
      return {
        id: "codex",
        kind: "runtime",
        endpoint: config.codexEndpoint || "(spawn)",
        sessionsFile: config.sessionsFile,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      };
    },
    createClient() {
      return ensureClient();
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      eventListeners.add(listener);
      const runtimeClient = ensureClient();
      const unsubscribe = runtimeClient.onMessage((message) => {
        const event = mapCodexMessageToRuntimeEvent(message);
        if (event) {
          listener(event, message);
        }
      });
      return () => {
        eventListeners.delete(listener);
        unsubscribe?.();
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities({ model = "" } = {}) {
      const forcedNativeImageInput = config.codexNativeImageInput;
      if (typeof forcedNativeImageInput === "boolean") {
        return {
          nativeImageInput: forcedNativeImageInput,
          toolImageRead: false,
        };
      }
      const effectiveModel = normalizeText(configuredModel) || normalizeText(model);
      const catalog = sessionStore.getAvailableModelCatalog();
      const catalogModel = findModelByQuery(catalog?.models, effectiveModel);
      return {
        nativeImageInput: hasImageInputModality(catalogModel),
        toolImageRead: false,
      };
    },
    async initialize() {
      const runtimeClient = ensureClient();
      if (readyState && runtimeClient.isReady && runtimeClient.isTransportReady()) {
        return readyState;
      }
      await runtimeClient.connect();
      await runtimeClient.initialize();
      const modelResponse = await runtimeClient.listModels().catch(() => null);
      const models = Array.isArray(modelResponse?.result?.data)
        ? modelResponse.result.data
        : [];
      if (models.length) {
        sessionStore.setAvailableModelCatalog(models);
      }
      readyState = {
        endpoint: config.codexEndpoint || "(spawn)",
        models,
      };
      return readyState;
    },
    async close() {
      if (client) {
        await client.close();
      }
      readyState = null;
      client = null;
    },
    async startFreshThreadDraft() {
      return {};
    },
    async respondApproval({ requestId, decision, result = null }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      if (requestId == null || String(requestId).trim() === "") {
        throw new Error("approval response requires a requestId");
      }
      const responsePayload = result && typeof result === "object"
        ? result
        : { decision: decision === "accept" ? "accept" : "decline" };
      await runtimeClient.sendResponse(requestId, responsePayload);
      return {
        requestId,
        ...(result && typeof result === "object"
          ? { result: responsePayload }
          : { decision: responsePayload.decision }),
      };
    },
    async cancelTurn({ threadId, turnId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      await runtimeClient.cancelTurn({ threadId, turnId });
      return { threadId, turnId };
    },
    async resumeThread({ threadId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      return runtimeClient.resumeThread({
        threadId,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      });
    },
    async compactThread({ threadId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      return runtimeClient.compactThread({ threadId });
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "", modelProvider = "" }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      const refreshText = buildInstructionRefreshText(config);
      const desiredModel = resolveModel(model, { modelProvider });
      await runtimeClient.resumeThread({
        threadId,
        model: desiredModel,
        modelProvider: configuredModelProvider,
      });
      const completion = waitForTurnCompletion(runtimeClient, threadId);
      await runtimeClient.sendUserMessage({
        threadId,
        text: refreshText,
        model: desiredModel,
        modelProvider: configuredModelProvider,
        workspaceRoot,
      });
      const result = await completion;
      return { threadId, ...result };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, model = "" }) {
      const runtimeClient = ensureClient();
      await this.initialize();

      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const storedParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const desiredModel = resolveModel(model, storedParams);
      const desiredModelProvider = configuredModelProvider;
      if (threadId && !runtimeParamsMatch(storedParams, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      })) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
      }
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      });
      let outboundText = text;
      if (!threadId) {
        const response = await runtimeClient.startThread({
          cwd: workspaceRoot,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        });
        threadId = extractThreadId(response);
        if (!threadId) {
          throw new Error("thread/start did not return a thread id");
        }
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
        outboundText = buildOpeningTurnText(config, text);
      } else {
        const desktopQueuedTurn = await runtimeClient.resumeThread({
          threadId,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        }).then(() => null).catch(async (error) => {
          const reason = error instanceof Error ? error.message : String(error || "unknown error");
          console.error(`[cyberboss] thread resume failed thread=${threadId}: ${reason}`);
          if (isActiveWriterError(reason)) {
            const rolloutFile = findRolloutFile(threadId);
            if (!rolloutFile) {
              throw new Error(`Unable to locate rollout file for active Desktop thread ${threadId}`);
            }
            const startOffset = fs.statSync(rolloutFile).size;
            const queued = await queueDesktopThread({
              codexCommand: config.codexCommand,
              threadId,
              text,
              attachments,
              model: desiredModel,
              workspaceRoot,
            });
            const syntheticTurnId = normalizeText(queued.messageId) || `desktop-queue-${Date.now()}`;
            return { threadId, turnId: syntheticTurnId, rolloutFile, startOffset };
          }
          throw new Error(`Unable to resume bound thread ${threadId}: ${reason}`);
        });
        if (desktopQueuedTurn) {
          setTimeout(() => {
            void monitorQueuedDesktopTurn({
              ...desktopQueuedTurn,
              emit: (event) => {
                for (const listener of eventListeners) {
                  listener(event, null);
                }
              },
            }).catch((error) => {
              const reason = error instanceof Error ? error.stack || error.message : String(error);
              console.error(`[cyberboss] Desktop thread monitor failed thread=${threadId}: ${reason}`);
            });
          }, 0);
          return { threadId, turnId: desktopQueuedTurn.turnId };
        }
      }

      const response = await runtimeClient.sendUserMessage({
        threadId,
        text: outboundText,
        attachments,
        model: desiredModel,
        modelProvider: desiredModelProvider,
        workspaceRoot,
      });
      return {
        threadId,
        turnId: extractTurnId(response),
      };
    },
  };
}

module.exports = { createCodexRuntimeAdapter };

function isActiveWriterError(message) {
  return normalizeText(message).toLowerCase().includes("already has an active writer");
}

function findRolloutFile(threadId) {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  if (!threadId || !fs.existsSync(sessionsDir)) {
    return "";
  }
  const stack = [sessionsDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
        return fullPath;
      }
    }
  }
  return "";
}

function queueDesktopThread({ codexCommand, threadId, text, attachments = [], model = "", workspaceRoot = "" }) {
  return new Promise((resolve, reject) => {
    // The WindowsApps codex alias must be launched through cmd.exe, but cmd
    // treats CR/LF inside an argument as command separators. U+2028 preserves
    // the message's line boundaries without being parsed by cmd as a newline.
    const queueText = process.platform === "win32"
      ? String(text || "").replace(/\r\n|\r|\n/g, "\u2028")
      : text;
    const args = ["/d", "/s", "/c", codexCommand || "codex", "queue", "--thread", threadId, "--message", queueText];
    if (model) {
      args.push("--model", model);
    }
    if (workspaceRoot) {
      args.push("--cd", workspaceRoot);
    }
    for (const attachment of attachments) {
      const imagePath = normalizeText(attachment?.absolutePath);
      if (imagePath) {
        args.push("--image", imagePath);
      }
    }
    const child = spawn("cmd.exe", args, {
      env: {
        ...process.env,
        CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(normalizeText(stderr) || normalizeText(stdout) || `codex queue exited ${code}`));
        return;
      }
      const messageId = stdout.match(/Queued message\s+([^\s]+)/i)?.[1] || "";
      console.log(`[cyberboss] queued turn into active Desktop thread=${threadId} message=${messageId}`);
      resolve({ messageId });
    });
  });
}

async function monitorQueuedDesktopTurn({ rolloutFile, startOffset, threadId, turnId, emit }) {
  console.log(`[cyberboss] monitoring Desktop thread=${threadId} turn=${turnId} offset=${startOffset}`);
  const deadline = Date.now() + 10 * 60_000;
  let offset = startOffset;
  let carry = "";
  let replySent = false;
  while (Date.now() < deadline) {
    const size = fs.statSync(rolloutFile).size;
    if (size > offset) {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(rolloutFile, "r");
      try {
        fs.readSync(fd, buffer, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      offset = size;
      const lines = (carry + buffer.toString("utf8")).split(/\r?\n/);
      carry = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const payload = record?.payload || {};
        if (record?.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer") {
          const reply = normalizeText(payload.message);
          if (reply && !replySent) {
            replySent = true;
            console.log(`[cyberboss] Desktop reply captured thread=${threadId} turn=${turnId} chars=${reply.length}`);
            emit({
              type: "runtime.reply.completed",
              payload: { threadId, turnId, itemId: `desktop-${turnId}`, text: reply },
            });
          }
        }
        if (record?.type === "event_msg" && payload.type === "task_complete") {
          if (!replySent) {
            const reply = normalizeText(payload.last_agent_message);
            if (reply) {
              replySent = true;
              console.log(`[cyberboss] Desktop completion reply captured thread=${threadId} turn=${turnId} chars=${reply.length}`);
              emit({
                type: "runtime.reply.completed",
                payload: { threadId, turnId, itemId: `desktop-${turnId}`, text: reply },
              });
            }
          }
          console.log(`[cyberboss] Desktop turn completed thread=${threadId} turn=${turnId}`);
          emit({ type: "runtime.turn.completed", payload: { threadId, turnId } });
          return;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  emit({
    type: "runtime.turn.failed",
    payload: { threadId, turnId, text: "Desktop thread reply timed out" },
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function runtimeParamsMatch(storedParams, desiredParams) {
  return normalizeText(storedParams?.model) === normalizeText(desiredParams?.model)
    && normalizeText(storedParams?.modelProvider) === normalizeText(desiredParams?.modelProvider);
}

function hasImageInputModality(model) {
  const modalities = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
  return modalities.some((item) => normalizeText(item).toLowerCase() === "image");
}

function waitForTurnCompletion(client, threadId) {
  return new Promise((resolve, reject) => {
    let activeTurnId = "";
    const itemOrder = [];
    const completedTextByItemId = new Map();

    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("codex turn timed out"));
    }, 10 * 60_000);

    const unsubscribe = client.onMessage((message) => {
      const params = message?.params || {};
      if (extractThreadIdFromParams(params) !== threadId) {
        return;
      }

      if ((message?.method === "turn/started" || message?.method === "turn/start") && !activeTurnId) {
        activeTurnId = extractTurnIdFromParams(params);
        return;
      }

      if (isAssistantItemCompleted(message)) {
        const itemId = typeof params?.item?.id === "string" ? params.item.id.trim() : `item-${itemOrder.length + 1}`;
        if (!completedTextByItemId.has(itemId)) {
          itemOrder.push(itemId);
        }
        completedTextByItemId.set(itemId, extractAssistantText(params));
        return;
      }

      if (message?.method === "turn/failed") {
        cleanup();
        reject(new Error(extractFailureText(params)));
        return;
      }

      if (message?.method === "turn/completed") {
        const completedTurnId = extractTurnIdFromParams(params);
        if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
          return;
        }
        cleanup();
        const text = itemOrder
          .map((itemId) => completedTextByItemId.get(itemId) || "")
          .filter(Boolean)
          .join("\n\n")
          .trim();
        resolve({
          turnId: completedTurnId || activeTurnId,
          text: text || "Completed.",
        });
      }
    });
  });
}
