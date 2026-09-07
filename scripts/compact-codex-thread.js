#!/usr/bin/env node
const fs = require("fs");
const crypto = require("crypto");
const { loadCyberbossEnv } = require("../src/core/env-loader");

loadCyberbossEnv();

const { readConfig } = require("../src/core/config");

async function main() {
  const operation = String(process.argv[2] || "").trim();
  const threadId = String(operation === "--mark-completed" ? process.argv[3] : operation).trim();
  if (!threadId) {
    throw new Error("Usage: node scripts/compact-codex-thread.js <threadId>");
  }

  const config = readConfig();
  const commandFile = config.runtimeCommandFile;
  fs.mkdirSync(path.dirname(commandFile), { recursive: true });
  if (operation === "--mark-completed") {
    const existing = JSON.parse(fs.readFileSync(commandFile, "utf8"));
    if (String(existing.threadId || "").trim() !== threadId) {
      throw new Error("The pending runtime command belongs to a different thread.");
    }
    const completed = {
      ...existing,
      status: "completed",
      turnId: String(process.argv[4] || "").trim(),
      completedAt: new Date().toISOString(),
      reconciledFromRollout: true,
    };
    fs.writeFileSync(commandFile, JSON.stringify(completed, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, reconciled: true, threadId, commandFile })}\n`);
    return;
  }
  fs.writeFileSync(commandFile, JSON.stringify({
    id: crypto.randomUUID(),
    type: "compact_thread",
    threadId,
    status: "pending",
    createdAt: new Date().toISOString(),
  }, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, queued: true, threadId, commandFile })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
