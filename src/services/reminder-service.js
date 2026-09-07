const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { ReminderQueueStore, DEFAULT_TIMEZONE } = require("../adapters/channel/weixin/reminder-queue-store");
const { ReminderAudit } = require("./reminder-audit");
const { resolvePreferredSenderId } = require("../core/default-targets");
const { resolveBodyInput } = require("./text-input");

const DELAY_UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};
const LOCAL_TIMEZONE_OFFSET = "+08:00";
const ABSOLUTE_TIME_WITH_TZ_RE = /([zZ]|[+-]\d{2}:\d{2})$/;

class ReminderService {
  constructor({ config, sessionStore, todoService = null }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.queue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.audit = new ReminderAudit({ logFile: config.reminderAuditLogFile });
    this.todoService = todoService;
  }

  async create({
    delay = "",
    delayMinutes = undefined,
    at = "",
    dueAt = "",
    text = "",
    textFile = "",
    userId = "",
    kind = "",
    sourceTodoId = "",
    todoVersion = 0,
    dedupeKey = "",
    recurrence = "",
  } = {}, context = {}) {
    const body = await resolveBodyInput({ text, textFile });
    if (!body) {
      throw new Error("Reminder text cannot be empty. Pass text or textFile.");
    }

    const dueAtMs = resolveDueAtMs({ delay, delayMinutes, at, dueAt });
    if (!Number.isFinite(dueAtMs) || dueAtMs <= Date.now()) {
      throw new Error("Missing a valid time. Use delayMinutes or dueAt like 2026-04-07T21:30+08:00.");
    }

    // Absolute times must carry a timezone so we can store UTC reliably.
    const absoluteInput = String(dueAt || at || "").trim();
    if (absoluteInput && !ABSOLUTE_TIME_WITH_TZ_RE.test(absoluteInput)) {
      throw new Error(
        `dueAt must include a timezone offset (e.g. 2026-04-07T21:30+08:00 or ...Z). Received: ${absoluteInput}`,
      );
    }

    const account = resolveSelectedAccount(this.config);
    const senderId = resolveReminderSenderId({
      config: this.config,
      accountId: account.accountId,
      explicitUser: userId,
      context,
      sessionStore: this.sessionStore,
    });
    if (!senderId) {
      throw new Error("Cannot determine the WeChat user for this reminder.");
    }

    const contextTokens = loadPersistedContextTokens(this.config, account.accountId);
    const contextToken = String(contextTokens[senderId] || "").trim();
    if (!contextToken) {
      throw new Error(`Cannot find context_token for ${senderId}. Let this user talk to the bot once first.`);
    }

    const normalizedKind = String(kind || "").trim().toLowerCase() === "todo_check" ? "todo_check" : "fixed_time";
    const reminder = this.queue.enqueue({
      id: crypto.randomUUID(),
      kind: normalizedKind,
      accountId: account.accountId,
      senderId,
      contextToken,
      text: body,
      dueAtMs,
      timezone: DEFAULT_TIMEZONE,
      createdAt: new Date().toISOString(),
      sourceTodoId: String(sourceTodoId || "").trim(),
      todoVersion: Number.isFinite(Number(todoVersion)) ? Number(todoVersion) : 0,
      dedupeKey: String(dedupeKey || "").trim(),
      recurrence: normalizeRecurrence(recurrence),
    });

    const warnings = [];
    const textTimeWarning = detectTextTimeMismatch(body, dueAtMs);
    if (textTimeWarning) {
      warnings.push(textTimeWarning);
    }

    this.audit.write({
      action: "create",
      reminderId: reminder.id,
      kind: reminder.kind,
      dueAtMs,
      timezone: reminder.timezone,
      sourceTodoId: reminder.sourceTodoId,
      todoVersion: reminder.todoVersion,
      dedupeKey: reminder.dedupeKey,
      duplicate: !!reminder.duplicate,
      warning: warnings.join("; ") || "",
    });

    return { ...reminder, dueAtPreview: formatBeijingPreview(reminder.dueAtMs), warnings };
  }

  /** Filtered query — backs the reminder_list tool. */
  list({ id = "", status = "", date = "", sourceTodoId = "", limit = 0 } = {}) {
    const statuses = String(status || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    let fromMs = 0;
    let toMs = 0;
    if (date) {
      const parsed = Date.parse(normalizeDateOnly(date));
      if (Number.isFinite(parsed)) {
        fromMs = parsed;
        toMs = parsed + 24 * 60 * 60_000;
      }
    }
    const items = this.queue.list({
      id: String(id || "").trim(),
      statuses,
      fromMs,
      toMs,
      sourceTodoId: String(sourceTodoId || "").trim(),
      limit: Number.parseInt(limit, 10) || 0,
    });
    return items.map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      status: r.status,
      dueAtMs: r.dueAtMs,
      dueAtPreview: formatBeijingPreview(r.dueAtMs),
      sourceTodoId: r.sourceTodoId,
      todoVersion: r.todoVersion,
      attempts: r.attempts,
      recurrence: r.recurrence,
      dedupeKey: r.dedupeKey,
      nextRunAtMs: r.nextRunAtMs || (r.status === "scheduled" ? r.dueAtMs : 0),
      nextRunAtPreview: formatBeijingPreview(r.nextRunAtMs || (r.status === "scheduled" ? r.dueAtMs : 0)),
      createdAt: r.createdAt,
    }));
  }

  /** Backs the reminder_update tool: cancel / ack / reschedule. */
  update({ id = "", action = "", dueAt = "", delayMinutes = 0 } = {}) {
    const reminderId = String(id || "").trim();
    if (!reminderId) {
      return { ok: false, error: "id is required" };
    }
    const op = String(action || "").trim().toLowerCase();
    const existing = this.queue.getById(reminderId);
    if (!existing) {
      return { ok: false, error: `Reminder not found: ${reminderId}` };
    }
    if (op === "cancel") {
      this.queue.cancel(reminderId);
      this.audit.write({ action: "cancel", reminderId, kind: existing.kind });
      return { ok: true, action: "cancelled", id: reminderId };
    }
    if (op === "ack") {
      const shouldAdvance = existing.status === "scheduled" || existing.status === "fired";
      this.queue.acknowledge(reminderId);
      let nextReminder = null;
      let todo = null;
      if (shouldAdvance && existing.kind === "fixed_time" && normalizeRecurrence(existing.recurrence)) {
        const nextDueAtMs = calculateNextOccurrence(existing.dueAtMs, existing.recurrence, Date.now());
        nextReminder = this.queue.enqueue({
          ...existing,
          id: crypto.randomUUID(),
          status: "scheduled",
          dueAtMs: nextDueAtMs,
          nextRunAtMs: nextDueAtMs,
          createdAt: new Date().toISOString(),
          triggeredAt: "",
          acknowledgedAt: "",
          expiredAt: "",
          attempts: 0,
        });
        this.audit.write({
          action: "recurrence_advance",
          reminderId,
          nextReminderId: nextReminder.id,
          recurrence: existing.recurrence,
          dueAtMs: nextDueAtMs,
        });
      } else if (shouldAdvance && existing.kind === "todo_check" && this.todoService) {
        const rearmed = this.todoService.rearmSupervision({
          id: existing.sourceTodoId,
          expectedVersion: existing.todoVersion,
        });
        if (!rearmed.error && rearmed.todo && rearmed.nextCheckAt) {
          todo = rearmed.todo;
          const nextDueAtMs = Date.parse(rearmed.nextCheckAt);
          nextReminder = this.queue.enqueue({
            ...existing,
            id: crypto.randomUUID(),
            status: "scheduled",
            dueAtMs: nextDueAtMs,
            nextRunAtMs: nextDueAtMs,
            todoVersion: todo.version,
            createdAt: new Date().toISOString(),
            triggeredAt: "",
            acknowledgedAt: "",
            expiredAt: "",
            attempts: 0,
          });
          this.audit.write({
            action: "todo_check_rearm",
            reminderId,
            nextReminderId: nextReminder.id,
            sourceTodoId: existing.sourceTodoId,
            todoVersion: todo.version,
            dueAtMs: nextDueAtMs,
          });
        } else {
          this.audit.write({
            action: "todo_check_rearm_skipped",
            reminderId,
            sourceTodoId: existing.sourceTodoId,
            reason: rearmed.error || "todo is no longer supervised",
          });
        }
      }
      this.audit.write({ action: "ack", reminderId, kind: existing.kind });
      const result = {
        ok: true,
        action: "acknowledged",
        id: reminderId,
      };
      if (nextReminder) {
        result.nextReminder = {
          id: nextReminder.id,
          dueAtMs: nextReminder.dueAtMs,
          dueAtPreview: formatBeijingPreview(nextReminder.dueAtMs),
        };
      }
      if (todo) {
        result.todo = { id: todo.id, version: todo.version, nextCheckAt: todo.nextCheckAt };
      }
      return result;
    }
    if (op === "reschedule") {
      const newDueAtMs = resolveDueAtMs({ delayMinutes, dueAt });
      if (!Number.isFinite(newDueAtMs) || newDueAtMs <= Date.now()) {
        return { ok: false, error: "Missing a valid new time. Use delayMinutes or dueAt with timezone (e.g. 2026-08-20T21:30+08:00)." };
      }
      if (dueAt && !ABSOLUTE_TIME_WITH_TZ_RE.test(String(dueAt).trim())) {
        return { ok: false, error: "dueAt must include a timezone offset (e.g. ...+08:00 or ...Z)." };
      }
      this.queue.reschedule(reminderId, newDueAtMs);
      this.audit.write({ action: "reschedule", reminderId, kind: existing.kind, dueAtMs: newDueAtMs });
      return { ok: true, action: "rescheduled", id: reminderId, dueAtMs: newDueAtMs };
    }
    return { ok: false, error: `Unknown action: ${action}. Use cancel, ack, or reschedule.` };
  }

  /** Cancel all active reminders for a todo (used when the plan changes/completes). */
  cancelByTodoId(todoId) {
    const active = this.queue.list({ sourceTodoId: todoId }).filter((r) => r.status !== "cancelled" && r.status !== "expired");
    for (const r of active) {
      this.queue.cancel(r.id);
      this.audit.write({ action: "cancel_by_todo", reminderId: r.id, sourceTodoId: todoId });
    }
    return active.length;
  }
}

function normalizeRecurrence(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "daily" || normalized === "weekly" ? normalized : "";
}

function calculateNextOccurrence(previousDueAtMs, recurrence, nowMs = Date.now()) {
  const intervalMs = normalizeRecurrence(recurrence) === "weekly"
    ? 7 * 24 * 60 * 60_000
    : 24 * 60 * 60_000;
  let nextDueAtMs = Number(previousDueAtMs) + intervalMs;
  while (nextDueAtMs <= nowMs) {
    nextDueAtMs += intervalMs;
  }
  return nextDueAtMs;
}

/**
 * Heuristic: if the reminder text contains an explicit HH:mm time that does not
 * match the dueAt time in the local timezone, warn (the model may have meant
 * a different time than the scheduling parameter).
 */
function detectTextTimeMismatch(text, dueAtMs) {
  const match = String(text || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return "";
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) {
    return "";
  }
  const local = new Date(dueAtMs + toOffsetMs(LOCAL_TIMEZONE_OFFSET));
  const localHours = local.getUTCHours();
  const localMinutes = local.getUTCMinutes();
  if (localHours !== hours || localMinutes !== minutes) {
    return `text mentions ${match[0]} but dueAt resolves to ${String(localHours).padStart(2, "0")}:${String(localMinutes).padStart(2, "0")} ${LOCAL_TIMEZONE_OFFSET}`;
  }
  return "";
}

function toOffsetMs(offset) {
  const m = String(offset || "").match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) {
    return 0;
  }
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number.parseInt(m[2], 10) * 60 + Number.parseInt(m[3], 10)) * 60_000;
}

function normalizeDateOnly(value) {
  const normalized = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `${normalized}T00:00:00${LOCAL_TIMEZONE_OFFSET}`;
  }
  return normalized;
}

function formatBeijingPreview(dueAtMs) {
  const ms = Number(dueAtMs);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const local = new Date(ms + toOffsetMs(LOCAL_TIMEZONE_OFFSET));
  const pad = (n) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}${LOCAL_TIMEZONE_OFFSET}`;
}

function resolveReminderSenderId({ config, accountId, explicitUser = "", context = {}, sessionStore = null }) {
  const explicit = normalizeText(explicitUser);
  if (explicit) {
    return explicit;
  }
  const contextual = normalizeText(context?.senderId);
  if (contextual) {
    return contextual;
  }
  return resolvePreferredSenderId({
    config,
    accountId,
    sessionStore,
  });
}

function resolveDueAtMs({ delay = "", delayMinutes = undefined, at = "", dueAt = "" } = {}) {
  const delayMs = parseDelay(delay);
  const normalizedDelayMinutes = parseDelayMinutes(delayMinutes);
  const scheduledAtMs = parseAbsoluteTime(dueAt || at);
  const timeSourceCount = [delayMs, normalizedDelayMinutes, scheduledAtMs].filter((value) => value > 0).length;
  if (timeSourceCount > 1) {
    throw new Error("Use only one of delay, delayMinutes, at, or dueAt.");
  }
  if (delayMs) {
    return Date.now() + delayMs;
  }
  if (normalizedDelayMinutes) {
    return Date.now() + normalizedDelayMinutes;
  }
  if (scheduledAtMs) {
    return scheduledAtMs;
  }
  return 0;
}

function parseDelayMinutes(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return 0;
  }
  const parsed = Number.parseInt(String(rawValue), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 60_000 : 0;
}

function parseDelay(rawValue) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) {
    return 0;
  }

  let totalMs = 0;
  let index = 0;
  while (index < normalized.length) {
    while (index < normalized.length && /\s/.test(normalized[index])) {
      index += 1;
    }
    if (index >= normalized.length) {
      break;
    }

    const match = normalized.slice(index).match(/^(\d+)\s*([smhd])/);
    if (!match) {
      return 0;
    }

    const amount = Number.parseInt(match[1], 10);
    const unitMs = DELAY_UNIT_MS[match[2]] || 0;
    if (!Number.isFinite(amount) || amount <= 0 || !unitMs) {
      return 0;
    }

    totalMs += amount * unitMs;
    index += match[0].length;
  }

  return totalMs > 0 ? totalMs : 0;
}

function parseAbsoluteTime(rawValue) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    return 0;
  }

  const normalizedIso = normalizeAbsoluteTimeString(normalized);
  const parsed = Date.parse(normalizedIso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAbsoluteTimeString(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  if (/([zZ]|[+-]\d{2}:\d{2})$/.test(normalized)) {
    return normalized.replace(" ", "T");
  }

  const dateTimeMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  if (dateTimeMatch) {
    return `${dateTimeMatch[1]}T${dateTimeMatch[2]}${LOCAL_TIMEZONE_OFFSET}`;
  }

  const dateOnlyMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnlyMatch) {
    return `${dateOnlyMatch[1]}T09:00:00${LOCAL_TIMEZONE_OFFSET}`;
  }

  return normalized;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ReminderService,
  parseAbsoluteTime,
  parseDelay,
  parseDelayMinutes,
  resolveDueAtMs,
  formatBeijingPreview,
  detectTextTimeMismatch,
  calculateNextOccurrence,
};
