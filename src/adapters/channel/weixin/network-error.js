const { redactSensitiveText } = require("./redact");

const DNS_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "EAI_FAIL"]);
const CONNECT_TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const REFUSED_CODES = new Set(["ECONNREFUSED"]);
const TLS_CODE_PATTERN = /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/;

function createWeixinNetworkError(error, {
  operation = "unknown",
  phase = "request",
  url = "",
  timeoutMs = 0,
  elapsedMs = 0,
  deadlineAborted = false,
} = {}) {
  if (error?.name === "WeixinNetworkError") {
    return error;
  }

  const chain = collectErrorChain(error);
  const code = findErrorCode(chain);
  const kind = classifyFailure(chain, code, deadlineAborted);
  const target = describeTarget(url);
  const detail = findUsefulDetail(chain);
  const message = [
    "[weixin-network]",
    `op=${safeToken(operation)}`,
    `phase=${safeToken(phase)}`,
    `kind=${kind}`,
    code ? `code=${safeToken(code)}` : "",
    target.host ? `host=${target.host}` : "",
    target.path ? `path=${target.path}` : "",
    timeoutMs > 0 ? `timeoutMs=${Math.round(timeoutMs)}` : "",
    elapsedMs >= 0 ? `elapsedMs=${Math.round(elapsedMs)}` : "",
    detail ? `cause=${JSON.stringify(detail)}` : "",
  ].filter(Boolean).join(" ");

  const wrapped = new Error(message, { cause: error instanceof Error ? error : undefined });
  wrapped.name = "WeixinNetworkError";
  wrapped.weixinOperation = String(operation || "unknown");
  wrapped.weixinPhase = String(phase || "request");
  wrapped.weixinFailureKind = kind;
  wrapped.weixinCode = code;
  wrapped.weixinHost = target.host;
  wrapped.weixinPath = target.path;
  wrapped.weixinTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  wrapped.weixinElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  wrapped.weixinDeadlineAborted = Boolean(deadlineAborted);
  return wrapped;
}

function collectErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && chain.length < 6 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function findErrorCode(chain) {
  for (const item of chain) {
    const code = typeof item?.code === "string" ? item.code.trim() : "";
    if (code) return code;
  }
  return "";
}

function classifyFailure(chain, code, deadlineAborted) {
  if (deadlineAborted) return "deadline_timeout";
  if (DNS_CODES.has(code)) return "dns";
  if (CONNECT_TIMEOUT_CODES.has(code)) return "connect_timeout";
  if (code === "UND_ERR_HEADERS_TIMEOUT") return "headers_timeout";
  if (code === "UND_ERR_BODY_TIMEOUT") return "body_timeout";
  if (RESET_CODES.has(code)) return "connection_reset";
  if (REFUSED_CODES.has(code)) return "connection_refused";
  if (TLS_CODE_PATTERN.test(code)) return "tls";

  const names = chain.map((item) => String(item?.name || "").toLowerCase());
  const messages = chain.map((item) => String(item?.message || "").toLowerCase()).join(" ");
  if (names.includes("aborterror") || messages.includes("aborted")) return "aborted";
  if (messages.includes("certificate") || messages.includes("tls") || messages.includes("ssl")) return "tls";
  if (messages.includes("timed out") || messages.includes("timeout")) return "timeout";
  return "transport";
}

function describeTarget(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return {
      host: safeToken(parsed.hostname.toLowerCase()),
      path: sanitizePath(parsed.pathname),
    };
  } catch {
    return { host: "", path: "" };
  }
}

function sanitizePath(value) {
  const path = String(value || "").replace(/[^A-Za-z0-9/_.,-]/g, "_");
  return path.length <= 160 ? path : `${path.slice(0, 160)}…`;
}

function safeToken(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120);
}

function findUsefulDetail(chain) {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const raw = typeof chain[index]?.message === "string" ? chain[index].message.trim() : "";
    if (!raw || raw === "fetch failed" || raw === "This operation was aborted") continue;
    const withoutUrls = raw.replace(/https?:\/\/\S+/gi, "<url-redacted>");
    return redactSensitiveText(withoutUrls, 200);
  }
  return "";
}

module.exports = { createWeixinNetworkError };
