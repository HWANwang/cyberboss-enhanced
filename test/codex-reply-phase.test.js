const test = require("node:test");
const assert = require("node:assert/strict");

const { mapCodexMessageToRuntimeEvent } = require("../src/adapters/runtime/codex/events");
const { StreamDelivery } = require("../src/core/stream-delivery");

function codexMessage(method, { itemId, text, phase }) {
  return {
    method,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId,
      item: {
        id: itemId,
        type: "agentMessage",
        text,
        phase,
      },
    },
  };
}

test("Codex commentary deltas are not exposed as reply events", () => {
  const event = mapCodexMessageToRuntimeEvent(codexMessage("item/agentMessage/delta", {
    itemId: "commentary-1",
    text: "先处理一下",
    phase: "commentary",
  }));

  assert.equal(event, null);
});

test("Codex compaction notification is exposed as a context event", () => {
  assert.deepEqual(mapCodexMessageToRuntimeEvent({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "compact-1" },
  }), {
    type: "runtime.context.compacted",
    payload: { threadId: "thread-1", turnId: "compact-1" },
  });
});

test("legacy Codex context_compacted event is exposed for compatibility", () => {
  assert.deepEqual(mapCodexMessageToRuntimeEvent({
    type: "event_msg",
    payload: { type: "context_compacted" },
  }), {
    type: "runtime.context.compacted",
    payload: { threadId: "", turnId: "" },
  });
});

test("Codex commentary completion discards an earlier phase-less delta", async () => {
  const sent = [];
  const streamDelivery = new StreamDelivery({
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
      getKnownContextTokens() {
        return {};
      },
    },
    sessionStore: {
      findBindingForThreadId() {
        return { bindingKey: "binding-1" };
      },
    },
  });
  streamDelivery.setReplyTarget("binding-1", {
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    messageId: "event-1",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.delta",
    payload: { threadId: "thread-1", turnId: "turn-1", itemId: "commentary-1", text: "先处理一下" },
  });
  await streamDelivery.handleRuntimeEvent(mapCodexMessageToRuntimeEvent(codexMessage("item/completed", {
    itemId: "commentary-1",
    text: "先处理一下",
    phase: "commentary",
  })));
  await streamDelivery.handleRuntimeEvent(mapCodexMessageToRuntimeEvent(codexMessage("item/completed", {
    itemId: "final-1",
    text: "最终正文",
    phase: "final_answer",
  })));
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(sent, [{
    userId: "user-1",
    text: "最终正文",
    contextToken: "ctx-1",
  }]);
});
