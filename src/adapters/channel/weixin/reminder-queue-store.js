const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEZONE = "+08:00";

// Status lifecycle: scheduled -> fired -> acknowledged
//                                 -> (retry/timeout) -> expired
//                    scheduled -> cancelled (todo completed / user cancelled)
const STATUS_SCHEDULED = "scheduled";
const STATUS_FIRED = "fired";
const STATUS_ACKNOWLEDGED = "acknowledged";
const STATUS_CANCELLED = "cancelled";
const STATUS_EXPIRED = "expired";

const TERMINAL_STATUSES = new Set([STATUS_ACKNOWLEDGED, STATUS_CANCELLED, STATUS_EXPIRED]);

class ReminderQueueStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { reminders: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const reminders = Array.isArray(parsed?.reminders) ? parsed.reminders : [];
      this.state = {
        reminders: reminders
          .map(normalizeReminder)
          .filter(Boolean)
          .sort((left, right) => left.dueAtMs - right.dueAtMs),
      };
    } catch {
      this.state = { reminders: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  _update(id, mutator) {
    this.load();
    const reminder = this.state.reminders.find((r) => r.id === id);
    if (!reminder) {
      return null;
    }
    const updated = mutator(reminder);
    this.state.reminders.sort((left, right) => left.dueAtMs - right.dueAtMs);
    this.save();
    return updated;
  }

  /**
   * Enqueue a reminder. If dedupeKey is set and an active reminder with the
   * same key exists, returns the existing one without queueing a duplicate.
   */
  enqueue(reminder) {
    this.load();
    const normalized = normalizeReminder(reminder);
    if (!normalized) {
      throw new Error("invalid reminder");
    }
    const key = normalized.dedupeKey;
    if (key) {
      const existing = this.state.reminders.find(
        (r) => r.dedupeKey === key && !TERMINAL_STATUSES.has(r.status),
      );
      if (existing) {
        return { ...existing, duplicate: true };
      }
    }
    this.state.reminders.push(normalized);
    this.state.reminders.sort((left, right) => left.dueAtMs - right.dueAtMs);
    this.save();
    return { ...normalized, duplicate: false };
  }

  /** All scheduled reminders that are due now (does NOT remove them). */
  listDue(nowMs = Date.now()) {
    this.load();
    return this.state.reminders.filter((r) => r.status === STATUS_SCHEDULED && r.dueAtMs <= nowMs);
  }

  /**
   * Recover recently overdue reminders and expire stale scheduled entries.
   * Returns the still-deliverable reminders so callers can fire them once.
   */
  sweepOverdueScheduled(nowMs = Date.now(), { graceMs = 24 * 60 * 60_000 } = {}) {
    this.load();
    const recoverable = [];
    const expired = [];
    let changed = false;
    for (const reminder of this.state.reminders) {
      if (reminder.status !== STATUS_SCHEDULED || reminder.dueAtMs > nowMs) {
        continue;
      }
      if (nowMs - reminder.dueAtMs <= graceMs) {
        recoverable.push(reminder);
        continue;
      }
      reminder.status = STATUS_EXPIRED;
      reminder.expiredAt = new Date(nowMs).toISOString();
      expired.push(reminder);
      changed = true;
    }
    if (changed) {
      this.save();
    }
    return { recoverable, expired };
  }

  /** Fired-but-unacknowledged reminders (candidates for retry). */
  listUnacknowledged(nowMs = Date.now()) {
    this.load();
    return this.state.reminders.filter((r) => r.status === STATUS_FIRED && !r.acknowledgedAt);
  }

  /**
   * Filtered query for the reminder_list tool.
   * @param {{id?: string, statuses?: string[], fromMs?: number, toMs?: number, sourceTodoId?: string, limit?: number}} opts
   */
  list(opts = {}) {
    this.load();
    const { id = "", statuses = [], fromMs = 0, toMs = 0, sourceTodoId = "", limit = 0 } = opts;
    let items = this.state.reminders;
    if (id) {
      items = items.filter((r) => r.id === id);
    }
    if (Array.isArray(statuses) && statuses.length) {
      const allowed = new Set(statuses.map((s) => String(s).toLowerCase()));
      items = items.filter((r) => allowed.has(r.status));
    }
    if (Number.isFinite(fromMs) && fromMs > 0) {
      items = items.filter((r) => r.dueAtMs >= fromMs);
    }
    if (Number.isFinite(toMs) && toMs > 0) {
      items = items.filter((r) => r.dueAtMs <= toMs);
    }
    if (sourceTodoId) {
      items = items.filter((r) => r.sourceTodoId === sourceTodoId);
    }
    items = [...items].sort((a, b) => a.dueAtMs - b.dueAtMs);
    if (Number.isInteger(limit) && limit > 0) {
      items = items.slice(0, limit);
    }
    return items;
  }

  getById(id) {
    this.load();
    return this.state.reminders.find((r) => r.id === id) || null;
  }

  markFired(id, nowMs = Date.now()) {
    return this._update(id, (r) => {
      r.status = STATUS_FIRED;
      r.triggeredAt = new Date(nowMs).toISOString();
      return r;
    });
  }

  acknowledge(id, nowMs = Date.now()) {
    return this._update(id, (r) => {
      if (r.status === STATUS_SCHEDULED || r.status === STATUS_FIRED) {
        r.status = STATUS_ACKNOWLEDGED;
        r.acknowledgedAt = new Date(nowMs).toISOString();
      }
      return r;
    });
  }

  cancel(id) {
    return this._update(id, (r) => {
      r.status = STATUS_CANCELLED;
      return r;
    });
  }

  expire(id) {
    return this._update(id, (r) => {
      r.status = STATUS_EXPIRED;
      return r;
    });
  }

  /** Reschedule a reminder (keeps it scheduled with a new due time). */
  reschedule(id, dueAtMs) {
    return this._update(id, (r) => {
      r.status = STATUS_SCHEDULED;
      r.dueAtMs = Number(dueAtMs);
      r.nextRunAtMs = Number(dueAtMs);
      return r;
    });
  }

  /** Retry a fired-but-unacknowledged reminder: back to scheduled, +1 attempt. */
  retry(id, newDueAtMs) {
    return this._update(id, (r) => {
      r.status = STATUS_SCHEDULED;
      r.dueAtMs = Number(newDueAtMs);
      r.nextRunAtMs = Number(newDueAtMs);
      r.attempts = (Number.isInteger(r.attempts) ? r.attempts : 0) + 1;
      r.triggeredAt = "";
      return r;
    });
  }

  /**
   * Maintenance pass:
   *  - fired reminders past retryBudgetMs with no ack -> expired
   *  - entries in terminal status older than retentionMs -> purged
   */
  reconcile(nowMs = Date.now(), { retryBudgetMs = 24 * 60 * 60_000, retentionMs = 7 * 24 * 60 * 60_000 } = {}) {
    this.load();
    let changed = false;
    const keep = [];
    for (const r of this.state.reminders) {
      if (r.status === STATUS_FIRED && !r.acknowledgedAt) {
        const firedAt = r.triggeredAt ? Date.parse(r.triggeredAt) : r.dueAtMs;
        if (nowMs - firedAt > retryBudgetMs) {
          r.status = STATUS_EXPIRED;
          changed = true;
        }
      }
      if (TERMINAL_STATUSES.has(r.status)) {
        const endRef = r.acknowledgedAt || r.triggeredAt || r.createdAt || r.dueAtMs;
        const endMs = typeof endRef === "number" ? endRef : Date.parse(endRef);
        if (Number.isFinite(endMs) && nowMs - endMs > retentionMs) {
          changed = true;
          continue; // purge
        }
      }
      keep.push(r);
    }
    if (changed) {
      this.state.reminders = keep.sort((a, b) => a.dueAtMs - b.dueAtMs);
      this.save();
    }
    return changed;
  }

  peekNextDueAtMs() {
    this.load();
    const first = this.state.reminders.find((r) => r.status === STATUS_SCHEDULED);
    return Number.isFinite(first?.dueAtMs) ? first.dueAtMs : 0;
  }
}

function normalizeReminder(reminder) {
  if (!reminder || typeof reminder !== "object") {
    return null;
  }
  const id = typeof reminder.id === "string" ? reminder.id.trim() : "";
  const kind = normalizeKind(reminder.kind);
  const accountId = typeof reminder.accountId === "string" ? reminder.accountId.trim() : "";
  const senderId = typeof reminder.senderId === "string" ? reminder.senderId.trim() : "";
  const contextToken = typeof reminder.contextToken === "string" ? reminder.contextToken.trim() : "";
  const text = typeof reminder.text === "string" ? reminder.text.trim() : "";
  const dueAtMs = Number(reminder.dueAtMs);
  const createdAt = typeof reminder.createdAt === "string" ? reminder.createdAt.trim() : "";
  if (!id || !accountId || !senderId || !contextToken || !Number.isFinite(dueAtMs) || dueAtMs <= 0) {
    return null;
  }
  const status = normalizeStatus(reminder.status);
  return {
    id,
    kind,
    accountId,
    senderId,
    contextToken,
    text,
    dueAtMs,
    timezone: typeof reminder.timezone === "string" && reminder.timezone.trim() ? reminder.timezone.trim() : DEFAULT_TIMEZONE,
    status,
    createdAt: createdAt || new Date().toISOString(),
    triggeredAt: typeof reminder.triggeredAt === "string" ? reminder.triggeredAt.trim() : "",
    acknowledgedAt: typeof reminder.acknowledgedAt === "string" ? reminder.acknowledgedAt.trim() : "",
    expiredAt: typeof reminder.expiredAt === "string" ? reminder.expiredAt.trim() : "",
    sourceTodoId: typeof reminder.sourceTodoId === "string" ? reminder.sourceTodoId.trim() : "",
    todoVersion: Number.isFinite(Number(reminder.todoVersion)) ? Number(reminder.todoVersion) : 0,
    dedupeKey: typeof reminder.dedupeKey === "string" ? reminder.dedupeKey.trim() : "",
    recurrence: typeof reminder.recurrence === "string" ? reminder.recurrence.trim() : "",
    nextRunAtMs: Number.isFinite(Number(reminder.nextRunAtMs)) ? Number(reminder.nextRunAtMs) : 0,
    attempts: Number.isInteger(reminder.attempts) ? reminder.attempts : 0,
  };
}

function normalizeKind(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "todo_check" ? "todo_check" : "fixed_time";
}

function normalizeStatus(value) {
  const v = String(value || "").trim().toLowerCase();
  if (TERMINAL_STATUSES.has(v) || v === STATUS_FIRED || v === STATUS_SCHEDULED) {
    return v;
  }
  return STATUS_SCHEDULED;
}

module.exports = {
  ReminderQueueStore,
  DEFAULT_TIMEZONE,
  STATUS_SCHEDULED,
  STATUS_FIRED,
  STATUS_ACKNOWLEDGED,
  STATUS_CANCELLED,
  STATUS_EXPIRED,
  TERMINAL_STATUSES,
};
