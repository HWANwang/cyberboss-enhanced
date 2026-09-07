const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolvePreferredSenderId } = require("../src/core/default-targets");

test("current account context token wins over a multi-user allowlist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-default-target-"));
  try {
    const accountId = "small-im.bot";
    fs.writeFileSync(
      path.join(tempDir, `${accountId}.context-tokens.json`),
      JSON.stringify({ "small-user": "small-context-token" }),
      "utf8",
    );
    const sessionStore = {
      state: {
        bindings: {
          old: { workspaceId: "default", accountId, senderId: "old-user" },
          current: { workspaceId: "default", accountId, senderId: "small-user" },
        },
      },
      getBinding() {
        return null;
      },
    };

    assert.equal(resolvePreferredSenderId({
      config: {
        workspaceId: "default",
        accountsDir: tempDir,
        allowedUserIds: ["big-user", "small-user"],
      },
      accountId,
      sessionStore,
    }), "small-user");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a multi-user allowlist is not treated as an account-specific default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-default-target-"));
  try {
    assert.equal(resolvePreferredSenderId({
      config: {
        workspaceId: "default",
        accountsDir: tempDir,
        allowedUserIds: ["big-user", "small-user"],
      },
      accountId: "unknown-im.bot",
      sessionStore: { state: { bindings: {} }, getBinding() { return null; } },
    }), "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
