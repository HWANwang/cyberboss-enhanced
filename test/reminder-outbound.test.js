const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { StreamDelivery } = require("../src/core/stream-delivery");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");
const { ReminderService } = require("../src/services/reminder-service");
const { ReminderQueueStore } = require("../src/adapters/channel/weixin/reminder-queue-store");

async function completeSystemTurn(streamDelivery, { threadId, turnId, text }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId, turnId, itemId: `${turnId}-reply`, text },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId, turnId },
  });
}

function createDeliveryHarness() {
  const sent = [];
  const streamDelivery = new StreamDelivery({
    runtimeId: "codex",
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
        return [{ message_id: "wechat-message-1" }];
      },
      getKnownContextTokens() {
        return {};
      },
    },
    sessionStore: {
      findBindingForThreadId() {
        return null;
      },
    },
  });
  return { sent, streamDelivery };
}

test("acknowledging a fired fixed_time reminder does not consume its final outbound reply", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-reminder-outbound-"));
  try {
    const service = new ReminderService({
      config: {
        reminderQueueFile: path.join(tempDir, "reminders.json"),
        reminderAuditLogFile: path.join(tempDir, "reminder-audit.jsonl"),
      },
      sessionStore: null,
    });
    service.queue.enqueue({
      id: "fixed-1",
      kind: "fixed_time",
      accountId: "bot-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      text: "测试提醒",
      dueAtMs: Date.now() - 1_000,
      createdAt: new Date().toISOString(),
    });
    service.queue.markFired("fixed-1");

    const { sent, streamDelivery } = createDeliveryHarness();
    streamDelivery.queueReplyTargetForThread("thread-1", {
      userId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
      messageId: "reminder:fixed-1",
    });

    assert.deepEqual(service.update({ id: "fixed-1", action: "ack" }), {
      ok: true,
      action: "acknowledged",
      id: "fixed-1",
    });

    await completeSystemTurn(streamDelivery, {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "{\"action\":\"send_message\",\"message\":\"fixed_time ack 后仍发送\"} ...\n</conversation> leaked tail",
    });

    assert.equal(service.queue.getById("fixed-1").status, "acknowledged");
    assert.deepEqual(sent, [{
      userId: "user-1",
      text: "fixed_time ack 后仍发送",
      contextToken: "ctx-1",
    }]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fixed_time, todo_check, checkin, and diagnostic system events retain one outbound target", async () => {
  const eventTypes = ["fixed_time", "todo_check", "checkin", "diagnostic"];
  const dispatcher = new SystemMessageDispatcher({
    queueStore: null,
    config: { workspaceId: "default", workspaceRoot: path.resolve("workspace") },
    accountId: "bot-1",
  });

  for (const [index, eventType] of eventTypes.entries()) {
    const id = `event-${eventType}`;
    const type = eventType === "checkin" ? "checkin" : "reminder_due";
    const prepared = dispatcher.buildPreparedMessage({
      id,
      accountId: "bot-1",
      senderId: "user-1",
      workspaceRoot: path.resolve("workspace"),
      text: JSON.stringify({ type, kind: eventType, text: `${eventType} test` }),
      createdAt: new Date().toISOString(),
    }, `ctx-${index}`);
    assert.equal(prepared.provider, "system");
    assert.equal(prepared.messageId, id);
    assert.match(prepared.text, new RegExp(eventType));

    const { sent, streamDelivery } = createDeliveryHarness();
    streamDelivery.queueReplyTargetForThread(`thread-${index}`, {
      userId: prepared.senderId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      messageId: prepared.messageId,
    });
    await completeSystemTurn(streamDelivery, {
      threadId: `thread-${index}`,
      turnId: `turn-${index}`,
      text: `{"action":"send_message","message":"${eventType} outbound"} ...\n</conversation>`,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, `${eventType} outbound`);
  }
});

test("acknowledging a recurring reminder schedules its next occurrence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-recurring-reminder-"));
  try {
    const service = new ReminderService({
      config: {
        reminderQueueFile: path.join(tempDir, "reminders.json"),
        reminderAuditLogFile: path.join(tempDir, "audit.jsonl"),
      },
      sessionStore: null,
    });
    const dueAtMs = Date.now() - 1_000;
    service.queue.enqueue({
      id: "daily-1",
      kind: "fixed_time",
      accountId: "bot-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      text: "daily test",
      dueAtMs,
      recurrence: "daily",
      dedupeKey: "daily:test",
      createdAt: new Date().toISOString(),
    });
    service.queue.markFired("daily-1");

    const result = service.update({ id: "daily-1", action: "ack" });
    const active = service.list({ status: "scheduled" });

    assert.equal(result.action, "acknowledged");
    assert.ok(result.nextReminder.id);
    assert.equal(active.length, 1);
    assert.equal(active[0].recurrence, "daily");
    assert.equal(active[0].dedupeKey, "daily:test");
    assert.ok(active[0].nextRunAtMs > Date.now());
    assert.match(active[0].nextRunAtPreview, /\+08:00$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("overdue sweep recovers recent reminders and expires stale scheduled data", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-overdue-reminder-"));
  try {
    const queue = new ReminderQueueStore({ filePath: path.join(tempDir, "reminders.json") });
    const now = Date.now();
    for (const [id, dueAtMs] of [["recent", now - 60_000], ["stale", now - 2 * 24 * 60 * 60_000]]) {
      queue.enqueue({
        id,
        kind: "fixed_time",
        accountId: "bot-1",
        senderId: "user-1",
        contextToken: "ctx-1",
        text: id,
        dueAtMs,
        createdAt: new Date().toISOString(),
      });
    }

    const result = queue.sweepOverdueScheduled(now, { graceMs: 24 * 60 * 60_000 });
    assert.deepEqual(result.recoverable.map((item) => item.id), ["recent"]);
    assert.deepEqual(result.expired.map((item) => item.id), ["stale"]);
    assert.equal(queue.getById("stale").status, "expired");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("acknowledging a todo_check re-arms supervision and queues the next check", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-todo-check-rearm-"));
  try {
    const todoCalls = [];
    const service = new ReminderService({
      config: {
        reminderQueueFile: path.join(tempDir, "reminders.json"),
        reminderAuditLogFile: path.join(tempDir, "audit.jsonl"),
      },
      sessionStore: null,
      todoService: {
        rearmSupervision(args) {
          todoCalls.push(args);
          return {
            todo: { id: args.id, version: 8, nextCheckAt: "2026-09-01T10:00:00.000Z" },
            nextCheckAt: "2026-09-01T10:00:00.000Z",
            error: null,
          };
        },
      },
    });
    service.queue.enqueue({
      id: "check-1",
      kind: "todo_check",
      accountId: "bot-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      text: "check progress",
      dueAtMs: Date.now() - 1_000,
      sourceTodoId: "todo_068",
      todoVersion: 7,
      dedupeKey: "todo:todo_068",
      createdAt: new Date().toISOString(),
    });
    service.queue.markFired("check-1");

    const result = service.update({ id: "check-1", action: "ack" });
    const next = service.list({ status: "scheduled", sourceTodoId: "todo_068" });

    assert.deepEqual(todoCalls, [{ id: "todo_068", expectedVersion: 7 }]);
    assert.equal(result.todo.version, 8);
    assert.equal(next.length, 1);
    assert.equal(next[0].todoVersion, 8);
    assert.equal(next[0].dedupeKey, "todo:todo_068");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
