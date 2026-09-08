const test = require("node:test");
const assert = require("node:assert/strict");

const { sendText } = require("../src/adapters/channel/weixin/api");
const { createWeixinNetworkError } = require("../src/adapters/channel/weixin/network-error");

test("WeChat network errors expose nested DNS causes without leaking query secrets", () => {
  const cause = Object.assign(new Error("getaddrinfo EAI_AGAIN ilinkai.weixin.qq.com"), {
    code: "EAI_AGAIN",
  });
  const outer = new TypeError("fetch failed", { cause });
  const error = createWeixinNetworkError(outer, {
    operation: "getUpdates",
    url: "https://ilinkai.weixin.qq.com/ilink/bot/getupdates?context_token=secret-value",
    timeoutMs: 40_000,
    elapsedMs: 123,
  });

  assert.equal(error.weixinFailureKind, "dns");
  assert.equal(error.weixinCode, "EAI_AGAIN");
  assert.match(error.message, /op=getUpdates/);
  assert.match(error.message, /kind=dns/);
  assert.match(error.message, /host=ilinkai\.weixin\.qq\.com/);
  assert.match(error.message, /path=\/ilink\/bot\/getupdates/);
  assert.doesNotMatch(error.message, /secret-value/);
});

test("WeChat network errors distinguish deadline aborts and socket resets", () => {
  const deadline = createWeixinNetworkError(Object.assign(new Error("aborted"), {
    name: "AbortError",
  }), {
    operation: "getUpdates",
    deadlineAborted: true,
    timeoutMs: 40_000,
    elapsedMs: 40_001,
  });
  assert.equal(deadline.weixinFailureKind, "deadline_timeout");
  assert.equal(deadline.weixinDeadlineAborted, true);

  const socket = createWeixinNetworkError(new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  }), { operation: "sendMessage" });
  assert.equal(socket.weixinFailureKind, "connection_reset");
  assert.match(socket.message, /code=UND_ERR_SOCKET/);
});

test("iLink API propagates classified network diagnostics and redacts payload secrets", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
  };
  try {
    await assert.rejects(
      sendText({
        baseUrl: "https://ilinkai.weixin.qq.com/",
        token: "private-bot-token",
        toUserId: "private-user-id",
        text: "private-message-body",
        contextToken: "private-context-token",
      }),
      (error) => {
        assert.equal(error.weixinFailureKind, "connect_timeout");
        assert.match(error.message, /op=sendMessage/);
        assert.match(error.message, /code=UND_ERR_CONNECT_TIMEOUT/);
        assert.doesNotMatch(error.message, /private-(?:bot|user|message|context)/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});
