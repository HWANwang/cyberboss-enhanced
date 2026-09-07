const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadCyberbossEnv } = require("./core/env-loader");

const { readConfig } = require("./core/config");
const { renderInstructionTemplate } = require("./core/instructions-template");
const { CyberbossApp } = require("./core/app");
const { runSystemCheckinPoller } = require("./app/system-checkin-poller");
const { buildTerminalHelpText } = require("./core/command-registry");
const { ensureStickerCatalogFilesSync } = require("./services/sticker-service");
const { createProjectTooling } = require("./tools/create-project-tooling");
const { runToolMcpServer } = require("./tools/mcp-stdio-server");

function ensureDefaultStateDirectory() {
  fs.mkdirSync(path.join(os.homedir(), ".cyberboss"), { recursive: true });
}

function acquireInstanceLock(stateDir) {
  const lockFile = path.join(stateDir, "cyberboss.pid");
  function isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }
  try {
    if (fs.existsSync(lockFile)) {
      const oldPid = Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
      if (Number.isInteger(oldPid) && oldPid > 0 && isProcessAlive(oldPid)) {
        console.error(`[cyberboss] another instance is already running (PID ${oldPid}); exiting.`);
        process.exit(0);
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid), "utf8");
  } catch (error) {
    console.error(`[cyberboss] failed to acquire instance lock: ${error.message}`);
    process.exit(1);
  }
  return function release() {
    try {
      if (fs.existsSync(lockFile) && Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10) === process.pid) {
        fs.unlinkSync(lockFile);
      }
    } catch {}
  };
}

function loadEnv() {
  ensureDefaultStateDirectory();
  loadCyberbossEnv();
}

function ensureRuntimeEnv() {
  if (!process.env.CYBERBOSS_HOME) {
    process.env.CYBERBOSS_HOME = path.resolve(__dirname, "..");
  }
}

function ensureBootstrapFiles(config) {
  ensureInstructionTemplate(config?.weixinInstructionsFile, "weixin-instructions.md", config);
  ensureInstructionTemplate(config?.weixinOperationsFile, "weixin-operations.md", config);
  ensureStickerCatalogFilesSync(config);
}

function ensureInstructionTemplate(filePath, templateName, config) {
  const normalizedFilePath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedFilePath || fs.existsSync(normalizedFilePath)) {
    return;
  }

  const templatePath = path.resolve(__dirname, "..", "templates", templateName);
  let template = "";
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    return;
  }

  const userName = String(config?.userName || "").trim() || "User";
  const content = renderInstructionTemplate(template, {
    ...config,
    userName,
  }).trimEnd() + "\n";
  fs.mkdirSync(path.dirname(normalizedFilePath), { recursive: true });
  fs.writeFileSync(normalizedFilePath, content, "utf8");
}

function printHelp() {
  console.log(buildTerminalHelpText());
}

let runtimeErrorHooksInstalled = false;

function installRuntimeErrorHooks() {
  if (runtimeErrorHooksInstalled) {
    return;
  }
  runtimeErrorHooksInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[cyberboss] unhandled rejection ${message}`);
  });

  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[cyberboss] uncaught exception ${message}`);
    process.exitCode = 1;
  });
}

async function main() {
  loadEnv();
  ensureRuntimeEnv();
  installRuntimeErrorHooks();
  const argv = process.argv.slice(2);
  const config = readConfig();
  ensureBootstrapFiles(config);
  const command = config.mode || "help";
  let app = null;
  const getApp = () => {
    if (!app) {
      app = new CyberbossApp(config);
    }
    return app;
  };

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(buildTerminalHelpText());
    return;
  }

  if (command === "doctor") {
    getApp().printDoctor();
    return;
  }

  if (command === "login") {
    await getApp().login();
    return;
  }

  if (command === "accounts") {
    getApp().printAccounts();
    return;
  }

  if (command === "start") {
    const release = acquireInstanceLock(config.stateDir);
    process.on("exit", release);
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
    await getApp().start();
    return;
  }

  if (command === "tool-mcp-server") {
    const runtimeId = readFlagValue(argv.slice(1), "--runtime-id") || "";
    const workspaceRoot = readFlagValue(argv.slice(1), "--workspace-root") || process.cwd();
    const stateDir = readFlagValue(argv.slice(1), "--state-dir");
    if (stateDir) {
      process.env.CYBERBOSS_STATE_DIR = stateDir;
    }
    // Re-read config after setting STATE_DIR so diaryDir et al use the correct path
    const freshConfig = readConfig();
    const { toolHost } = createProjectTooling(freshConfig);
    runToolMcpServer({ toolHost, runtimeId, workspaceRoot });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = { main };

function readFlagValue(args, flag) {
  if (!Array.isArray(args)) {
    return "";
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}
