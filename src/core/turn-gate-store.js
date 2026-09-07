class TurnGateStore {
  constructor({ staleMs = 15 * 60_000, now = () => Date.now() } = {}) {
    this.scopeByThreadId = new Map();
    this.pendingByScopeKey = new Map();
    this.staleMs = Math.max(1, Number(staleMs) || 15 * 60_000);
    this.now = typeof now === "function" ? now : () => Date.now();
  }

  begin(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return "";
    }
    this.pendingByScopeKey.set(scopeKey, {
      scopeKey,
      startedAtMs: this.now(),
      threadId: "",
      turnId: "",
    });
    return scopeKey;
  }

  attachThread(scopeKey, threadId, turnId = "") {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId) {
      return;
    }
    const entry = this.pendingByScopeKey.get(normalizedScopeKey);
    if (!entry) {
      return;
    }
    const attached = {
      ...entry,
      threadId: normalizedThreadId,
      turnId: normalizeText(turnId),
    };
    this.pendingByScopeKey.set(normalizedScopeKey, attached);
    this.scopeByThreadId.set(normalizedThreadId, attached);
  }

  releaseScope(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    this.releaseScopeKey(scopeKey);
  }

  releaseThread(threadId, turnId = "") {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return false;
    }
    const attached = this.scopeByThreadId.get(normalizedThreadId) || null;
    if (!attached) {
      return false;
    }
    const normalizedTurnId = normalizeText(turnId);
    if (normalizedTurnId && attached.turnId && normalizedTurnId !== attached.turnId) {
      return false;
    }
    this.releaseScopeKey(attached.scopeKey);
    return true;
  }

  getPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    const entry = scopeKey ? this.pendingByScopeKey.get(scopeKey) : null;
    if (!entry) {
      return null;
    }
    return {
      ...entry,
      ageMs: Math.max(0, this.now() - entry.startedAtMs),
      stale: this.now() - entry.startedAtMs >= this.staleMs,
    };
  }

  isPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    return scopeKey ? this.pendingByScopeKey.has(scopeKey) : false;
  }

  releaseScopeKey(scopeKey) {
    const normalizedScopeKey = normalizeText(scopeKey);
    if (!normalizedScopeKey) {
      return false;
    }
    const entry = this.pendingByScopeKey.get(normalizedScopeKey) || null;
    this.pendingByScopeKey.delete(normalizedScopeKey);
    if (entry?.threadId) {
      const current = this.scopeByThreadId.get(entry.threadId);
      if (current?.scopeKey === normalizedScopeKey) {
        this.scopeByThreadId.delete(entry.threadId);
      }
    }
    return Boolean(entry);
  }
}

function buildTurnScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TurnGateStore };
