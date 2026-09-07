const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../src/core/app");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");

function createMessage(overrides = {}) {
  return {
    id: "checkin-1",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: '{"type":"checkin"}',
    createdAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

test("system queue deduplicates the same account and event id", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-system-queue-"));
  const store = new SystemMessageQueueStore({ filePath: path.join(stateDir, "queue.json") });
  store.enqueue(createMessage());
  store.enqueue(createMessage({ attemptCount: 2, nextAttemptAtMs: 5000 }));

  const queued = store.drainForAccount("account-1", 4999);
  assert.deepEqual(queued, []);
  const due = store.drainForAccount("account-1", 5000);
  assert.equal(due.length, 1);
  assert.equal(due[0].attemptCount, 2);
});

test("concurrent system flush calls share one drain and dispatch", async () => {
  let dispatchCount = 0;
  let releaseDispatch;
  const dispatchWait = new Promise((resolve) => { releaseDispatch = resolve; });
  const appLike = {
    systemMessageFlushPromise: null,
    systemMessageDispatcher: {
      drainPending() {
        return [createMessage()];
      },
    },
    async dispatchSystemMessage() {
      dispatchCount += 1;
      await dispatchWait;
      return true;
    },
    flushPendingSystemMessagesOnce: CyberbossApp.prototype.flushPendingSystemMessagesOnce,
    requeueBlockedSystemMessage: CyberbossApp.prototype.requeueBlockedSystemMessage,
  };

  const first = CyberbossApp.prototype.flushPendingSystemMessages.call(appLike);
  const second = CyberbossApp.prototype.flushPendingSystemMessages.call(appLike);
  releaseDispatch();
  await Promise.all([first, second]);

  assert.equal(dispatchCount, 1);
  assert.equal(appLike.systemMessageFlushPromise, null);
});

test("blocked system events are requeued with exponential backoff metadata", async () => {
  const requeued = [];
  const appLike = {
    systemMessageFlushPromise: null,
    systemMessageDispatcher: {
      drainPending() {
        return [createMessage({ attemptCount: 3 })];
      },
      requeue(message, options) {
        requeued.push({ message, options });
      },
    },
    async dispatchSystemMessage() {
      return false;
    },
    flushPendingSystemMessagesOnce: CyberbossApp.prototype.flushPendingSystemMessagesOnce,
    requeueBlockedSystemMessage: CyberbossApp.prototype.requeueBlockedSystemMessage,
  };

  await CyberbossApp.prototype.flushPendingSystemMessages.call(appLike);

  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].options.delayMs, 8000);
});
