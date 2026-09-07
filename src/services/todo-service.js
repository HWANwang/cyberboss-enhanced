const fs = require("fs");
const path = require("path");

const SUPERVISION_NONE = "none";
const SUPERVISION_SUPERVISED = "supervised";

/**
 * TodoService — Todo is the single source of truth for tasks.
 *
 * Supervision fields support the remind-loop: supervise_start arms a todo with
 * a check interval; todo_progress reports started/blocked/snoozed/completed and
 * re-arms the next check; a todo_check reminder fires the model to follow up.
 *
 * version bumps ONLY on plan-semantic changes (due/status/checkIntervalMin/
 * snooze re-arms) so that stale todo_check reminders (carrying an old version)
 * are safely no-oped, while cosmetic edits (title/note) keep reminders alive.
 *
 * Progress history is appended to a separate todo-events.jsonl file so it never
 * bloats the todos.json payload the model sees.
 */
class TodoService {
  constructor({ filePath, eventsFilePath }) {
    this.filePath = filePath;
    this.eventsFilePath = eventsFilePath;
    this._cache = null;
  }

  _load() {
    if (this._cache) return this._cache;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this._cache = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        ? parsed
        : { todos: [], nextId: 1 };
    } catch {
      this._cache = { todos: [], nextId: 1 };
    }
    // normalize legacy todos (add new fields with defaults)
    for (const t of this._cache.todos || []) {
      if (t.version === undefined) t.version = 1;
      if (t.supervisionMode === undefined) t.supervisionMode = SUPERVISION_NONE;
      if (t.currentStep === undefined) t.currentStep = "";
      if (t.nextCheckAt === undefined) t.nextCheckAt = "";
      if (t.checkIntervalMin === undefined) t.checkIntervalMin = 0;
      if (t.snoozeCount === undefined) t.snoozeCount = 0;
      if (t.maxSnoozes === undefined) t.maxSnoozes = 0;
      if (t.lastProgressAt === undefined) t.lastProgressAt = "";
      if (t.completionCriteria === undefined) t.completionCriteria = "";
      if (t.lastHabitCompletedDate === undefined) t.lastHabitCompletedDate = "";
      if (t.habitCompletionCount === undefined) t.habitCompletionCount = 0;
      if (t.habitStreak === undefined) t.habitStreak = 0;
      if (t.status === "active") t.status = "pending"; // legacy: active folded into pending
    }
    return this._cache;
  }

  _save() {
    if (!this._cache) {
      this._load();
    }
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this._cache, null, 2), "utf8");
  }

  _invalidateCache() {
    this._cache = null;
  }

  _nextId() {
    const store = this._load();
    const id = store.nextId;
    store.nextId += 1;
    return id;
  }

  _appendEvent(todoId, type, detail = {}) {
    try {
      fs.mkdirSync(path.dirname(this.eventsFilePath), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        todoId,
        type,
        ...detail,
      });
      fs.appendFileSync(this.eventsFilePath, line + "\n", "utf8");
    } catch {
      // events must never break the todo pipeline
    }
  }

  /** Bump version on plan-semantic changes (invalidates stale reminders). */
  _bump(todo) {
    todo.version = (Number(todo.version) || 0) + 1;
    return todo.version;
  }

  /**
   * If a completed todo has repeat=daily or weekly, create the next instance.
   * Returns the spawned todo or null.
   */
  _spawnRecurring(completedTodo) {
    if (!completedTodo.repeat) return null;
    const store = this._load();
    const exists = (store.todos || []).some(
      (t) => t.title === completedTodo.title && t.repeat === completedTodo.repeat && t.status !== "completed",
    );
    if (exists) return null;

    let due = "";
    if (completedTodo.due) {
      const dueDate = new Date(completedTodo.due);
      if (!isNaN(dueDate.getTime())) {
        if (completedTodo.repeat === "daily") {
          dueDate.setDate(dueDate.getDate() + 1);
        } else if (completedTodo.repeat === "weekly") {
          dueDate.setDate(dueDate.getDate() + 7);
        }
        due = dueDate.toISOString().split("T")[0];
      }
    }

    const id = `todo_${String(this._nextId()).padStart(3, "0")}`;
    const todo = {
      id,
      title: completedTodo.title,
      due,
      repeat: completedTodo.repeat,
      note: completedTodo.note,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      supervisionMode: SUPERVISION_NONE,
      currentStep: "",
      nextCheckAt: "",
      checkIntervalMin: 0,
      snoozeCount: 0,
      maxSnoozes: 0,
      lastProgressAt: "",
      completionCriteria: "",
      lastHabitCompletedDate: "",
      habitCompletionCount: 0,
      habitStreak: 0,
    };
    store.todos.push(todo);
    this._save();
    this._invalidateCache();
    this._appendEvent(id, "spawned", { fromTodoId: completedTodo.id });
    return todo;
  }

  list({ includeCompleted = false } = {}) {
    const store = this._load();
    for (const t of store.todos || []) {
      if (t.status === "completed" && t.repeat) {
        this._spawnRecurring(t);
      }
    }
    const fresh = this._load();
    const freshTodos = fresh.todos || [];
    if (!includeCompleted) {
      return { todos: freshTodos.filter((t) => t.status !== "completed"), total: freshTodos.length };
    }
    return { todos: freshTodos, total: freshTodos.length };
  }

  getById(id) {
    const store = this._load();
    const normalized = String(id || "").trim();
    return (store.todos || []).find((t) => t.id === normalized) || null;
  }

  create({ title, due = "", repeat = "", note = "", status = "" } = {}) {
    const store = this._load();
    const id = `todo_${String(store.nextId).padStart(3, "0")}`;
    const todo = {
      id,
      title: String(title || "").trim(),
      due: String(due || "").trim(),
      repeat: normalizeRepeat(String(repeat || "")),
      note: String(note || "").trim(),
      status: normalizeStatus(String(status || "")) || "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      supervisionMode: SUPERVISION_NONE,
      currentStep: "",
      nextCheckAt: "",
      checkIntervalMin: 0,
      snoozeCount: 0,
      maxSnoozes: 0,
      lastProgressAt: "",
      completionCriteria: "",
      lastHabitCompletedDate: "",
      habitCompletionCount: 0,
      habitStreak: 0,
    };
    if (!todo.title) {
      return { error: "title is required", todo: null };
    }
    store.todos.push(todo);
    store.nextId += 1;
    this._save();
    this._invalidateCache();
    this._appendEvent(id, "created", { title: todo.title, due: todo.due });
    return { todo, error: null };
  }

  /**
   * Update fields. Bumps version when the plan semantics change
   * (due/status/checkIntervalMin) so stale reminders are invalidated.
   */
  update({ id, title, due, repeat, note, status } = {}) {
    const store = this._load();
    const todos = store.todos || [];
    const idx = todos.findIndex((t) => t.id === String(id || "").trim());
    if (idx < 0) {
      return { error: `Todo not found: ${id}`, todo: null };
    }
    const todo = todos[idx];
    const wasCompleted = todo.status === "completed";
    const planChangedBefore = collectPlanSignature(todo);

    if (title !== undefined) todo.title = String(title).trim();
    if (due !== undefined) todo.due = String(due).trim();
    if (repeat !== undefined) todo.repeat = normalizeRepeat(String(repeat));
    if (note !== undefined) todo.note = String(note).trim();
    if (status !== undefined) {
      const normalized = String(status).trim().toLowerCase();
      if (["pending", "completed"].includes(normalized)) {
        todo.status = normalized;
      } else if (normalized === "active") {
        // legacy state folded into pending — active carried no semantics
        todo.status = "pending";
      }
    }
    todo.updatedAt = new Date().toISOString();

    const planChangedAfter = collectPlanSignature(todo);
    if (planChangedBefore !== planChangedAfter) {
      this._bump(todo);
      this._appendEvent(todo.id, "plan_changed", { due: todo.due, status: todo.status, version: todo.version });
    }

    if (!wasCompleted && todo.status === "completed") {
      this._appendEvent(todo.id, "completed");
      const todosArr = store.todos || [];
      const doneIdx = todosArr.findIndex((t) => t.id === todo.id);
      if (doneIdx >= 0) {
        todosArr.splice(doneIdx, 1);
      }
      const spawned = todo.repeat ? this._spawnRecurring(todo) : null;
      if (!todo.repeat) {
        this._save();
        this._invalidateCache();
      }
      return { deleted: todo, spawned, error: null };
    }

    this._save();
    this._invalidateCache();
    return { todo, spawned: null, error: null };
  }

  /**
   * Enter supervision mode. Bumps version (plan changed) and records the event.
   * The caller is responsible for arming the first todo_check reminder.
   */
  superviseStart({ id, currentStep = "", checkIntervalMin = 0, maxSnoozes = 0, completionCriteria = "" } = {}) {
    const store = this._load();
    const todos = store.todos || [];
    const idx = todos.findIndex((t) => t.id === String(id || "").trim());
    if (idx < 0) {
      return { error: `Todo not found: ${id}`, todo: null };
    }
    const todo = todos[idx];
    if (todo.status === "completed") {
      return { error: "Cannot supervise a completed todo.", todo: null };
    }
    const interval = Number.parseInt(checkIntervalMin, 10);
    if (!Number.isInteger(interval) || interval <= 0) {
      return { error: "checkIntervalMin must be a positive integer (minutes).", todo: null };
    }
    todo.supervisionMode = SUPERVISION_SUPERVISED;
    todo.checkIntervalMin = interval;
    if (currentStep !== undefined) todo.currentStep = String(currentStep).trim();
    if (maxSnoozes !== undefined) todo.maxSnoozes = Number.parseInt(maxSnoozes, 10) || 0;
    if (completionCriteria !== undefined) todo.completionCriteria = String(completionCriteria).trim();
    todo.snoozeCount = 0;
    todo.lastProgressAt = new Date().toISOString();
    todo.nextCheckAt = new Date(Date.now() + interval * 60_000).toISOString();
    todo.updatedAt = new Date().toISOString();
    const version = this._bump(todo);
    this._save();
    this._invalidateCache();
    this._appendEvent(todo.id, "supervise_start", { intervalMin: interval, version });
    return { todo, error: null };
  }

  /**
   * Report progress. Returns nextCheckAt (ISO) when the next check is armed.
   * - started: updates currentStep/lastProgressAt (no version bump)
   * - blocked: updates note/lastProgressAt (no version bump)
   * - snoozed: +1 snooze; re-arms next check if under maxSnoozes (bump),
   *            otherwise returns exceeded=true for the caller to nudge the user
   * - completed: delegates to update(status=completed) (bump + delete/spawn)
   */
  progress({ id, status = "", note = "", nextCheckInMin = 0 } = {}) {
    const store = this._load();
    const todos = store.todos || [];
    const idx = todos.findIndex((t) => t.id === String(id || "").trim());
    if (idx < 0) {
      return { error: `Todo not found: ${id}`, todo: null };
    }
    const todo = todos[idx];
    const op = String(status || "").trim().toLowerCase();
    const nowMs = Date.now();

    if (op === "completed") {
      const result = this.update({ id: todo.id, status: "completed" });
      return { ...result, action: "completed" };
    }

    if (op === "started") {
      if (note !== undefined) todo.currentStep = String(note).trim();
      todo.lastProgressAt = new Date(nowMs).toISOString();
      todo.updatedAt = new Date(nowMs).toISOString();
      this._save();
      this._invalidateCache();
      this._appendEvent(todo.id, "progress_started", { step: todo.currentStep });
      return { todo, action: "started", nextCheckAt: todo.nextCheckAt, error: null };
    }

    if (op === "blocked") {
      if (note !== undefined) todo.note = String(note).trim();
      todo.lastProgressAt = new Date(nowMs).toISOString();
      todo.updatedAt = new Date(nowMs).toISOString();
      this._save();
      this._invalidateCache();
      this._appendEvent(todo.id, "progress_blocked", { note: todo.note });
      return { todo, action: "blocked", nextCheckAt: todo.nextCheckAt, error: null };
    }

    if (op === "snoozed") {
      const intervalMin = Number.isInteger(todo.checkIntervalMin) && todo.checkIntervalMin > 0
        ? todo.checkIntervalMin
        : Number.parseInt(nextCheckInMin, 10) || 0;
      if (intervalMin <= 0) {
        return { error: "snoozed requires a checkIntervalMin (set via supervise_start or nextCheckInMin).", todo: null };
      }
      todo.snoozeCount = (Number(todo.snoozeCount) || 0) + 1;
      todo.lastProgressAt = new Date(nowMs).toISOString();
      todo.updatedAt = new Date(nowMs).toISOString();
      const maxSnoozes = Number(todo.maxSnoozes) || 0;
      if (maxSnoozes > 0 && todo.snoozeCount > maxSnoozes) {
        // out of snoozes — keep the check armed, tell caller to nudge the user
        this._save();
        this._invalidateCache();
        this._appendEvent(todo.id, "snooze_exhausted", { snoozeCount: todo.snoozeCount, maxSnoozes });
        return { todo, action: "snooze_exhausted", error: null };
      }
      const nextAtMs = nowMs + intervalMin * 60_000;
      todo.nextCheckAt = new Date(nextAtMs).toISOString();
      const version = this._bump(todo);
      this._save();
      this._invalidateCache();
      this._appendEvent(todo.id, "snoozed", { snoozeCount: todo.snoozeCount, nextCheckAt: todo.nextCheckAt, version });
      return { todo, action: "snoozed", nextCheckAt: todo.nextCheckAt, version, error: null };
    }

    return { error: `Unknown progress status: ${status}. Use started, blocked, snoozed, or completed.`, todo: null };
  }

  /** Record today's completion for a persistent daily habit without closing it. */
  habitCheckin({ id, date = "", note = "" } = {}) {
    const store = this._load();
    const todo = (store.todos || []).find((item) => item.id === String(id || "").trim());
    if (!todo) {
      return { error: `Todo not found: ${id}`, todo: null };
    }
    if (todo.repeat !== "daily") {
      return { error: "habit_checkin requires a todo with repeat=daily.", todo: null };
    }
    const completionDate = normalizeHabitDate(date) || beijingDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(completionDate)) {
      return { error: "date must be YYYY-MM-DD.", todo: null };
    }
    if (todo.lastHabitCompletedDate === completionDate) {
      return { todo, date: completionDate, duplicate: true, error: null };
    }

    const previousDate = todo.lastHabitCompletedDate;
    todo.habitStreak = previousDate && addCalendarDays(previousDate, 1) === completionDate
      ? (Number(todo.habitStreak) || 0) + 1
      : 1;
    todo.habitCompletionCount = (Number(todo.habitCompletionCount) || 0) + 1;
    todo.lastHabitCompletedDate = completionDate;
    todo.lastProgressAt = new Date().toISOString();
    todo.updatedAt = todo.lastProgressAt;
    if (!todo.due || todo.due <= completionDate) {
      todo.due = addCalendarDays(completionDate, 1);
      this._bump(todo);
    }
    this._save();
    this._invalidateCache();
    this._appendEvent(todo.id, "habit_completed", {
      date: completionDate,
      note: String(note || "").trim(),
      streak: todo.habitStreak,
      completionCount: todo.habitCompletionCount,
    });
    return { todo, date: completionDate, duplicate: false, error: null };
  }

  /** Advance supervision after its current todo_check reminder is acknowledged. */
  rearmSupervision({ id, expectedVersion = 0, nowMs = Date.now() } = {}) {
    const store = this._load();
    const todo = (store.todos || []).find((item) => item.id === String(id || "").trim());
    if (!todo) {
      return { error: `Todo not found: ${id}`, todo: null };
    }
    if (todo.status === "completed" || todo.supervisionMode !== SUPERVISION_SUPERVISED) {
      return { error: "Todo is no longer under active supervision.", todo: null };
    }
    const expected = Number(expectedVersion) || 0;
    if (expected && Number(todo.version) !== expected) {
      return { error: "Todo plan changed; stale check was not re-armed.", todo: null };
    }
    const interval = Number(todo.checkIntervalMin) || 0;
    if (interval <= 0) {
      return { error: "Todo has no valid check interval.", todo: null };
    }
    todo.nextCheckAt = new Date(nowMs + interval * 60_000).toISOString();
    todo.updatedAt = new Date(nowMs).toISOString();
    const version = this._bump(todo);
    this._save();
    this._invalidateCache();
    this._appendEvent(todo.id, "supervision_rearmed", {
      nextCheckAt: todo.nextCheckAt,
      intervalMin: interval,
      version,
    });
    return { todo, nextCheckAt: todo.nextCheckAt, version, error: null };
  }

  checkOverdue() {
    const store = this._load();
    const now = new Date();
    const overdue = (store.todos || []).filter((t) => {
      if (t.status === "completed") return false;
      if (!t.due) return false;
      const dueDate = new Date(t.due);
      return dueDate < now;
    });
    return { overdue };
  }
}

/** Plan-semantic signature: changes here invalidate stale reminders. */
function collectPlanSignature(todo) {
  return [todo.due || "", todo.status || "", todo.checkIntervalMin || 0].join("|");
}

function normalizeStatus(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "completed") return v;
  // pending (and legacy "active") all fold into pending
  return "pending";
}

function normalizeRepeat(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "daily" || v === "weekly") return v;
  return "";
}

function normalizeHabitDate(value) {
  return String(value || "").trim();
}

function beijingDateString(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function addCalendarDays(date, days) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed + days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

module.exports = {
  TodoService,
  SUPERVISION_NONE,
  SUPERVISION_SUPERVISED,
};
