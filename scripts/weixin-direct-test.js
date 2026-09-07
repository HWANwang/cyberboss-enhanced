#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sendText } = require("../src/adapters/channel/weixin/api");

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

async function main() {
  const accountId = readArg("--account");
  const stateDir = readArg("--state-dir");
  if (!accountId || !stateDir) {
    throw new Error("Usage: weixin-direct-test.js --account <id> --state-dir <path>");
  }

  const accountsDir = path.join(path.resolve(stateDir), "accounts");
  const account = JSON.parse(fs.readFileSync(path.join(accountsDir, `${accountId}.json`), "utf8"));
  const contextTokens = JSON.parse(
    fs.readFileSync(path.join(accountsDir, `${accountId}.context-tokens.json`), "utf8"),
  );
  const userId = String(account.userId || "").trim();
  const contextToken = String(contextTokens[userId] || "").trim();
  if (!userId || !contextToken) {
    throw new Error("No current context token. Send one message to the bot first, then retry.");
  }

  const timestamp = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const result = await sendText({
    baseUrl: account.baseUrl,
    token: account.token,
    toUserId: userId,
    text: `Cyberboss 直连测试 ${timestamp}：这条消息绕过了 GPT 和线程回复。`,
    contextToken,
    clientId: `cb-direct-${crypto.randomUUID()}`,
  });

  console.log(JSON.stringify({
    accountId,
    userId,
    ret: result?.ret ?? null,
    errcode: result?.errcode ?? null,
    errmsg: result?.errmsg ?? "",
    hasMessageId: Boolean(result?.message_id || result?.msg_id),
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
