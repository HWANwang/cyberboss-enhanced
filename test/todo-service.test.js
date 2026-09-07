const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { TodoService } = require("../src/services/todo-service");

function createService(tempDir) {
  return new TodoService({
    filePath: path.join(tempDir, "todos.json"),
    eventsFilePath: path.join(tempDir, "todo-events.jsonl"),
  });
}

test("daily habit check-in records today without completing the todo", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-habit-"));
  try {
    const service = createService(tempDir);
    const created = service.create({ title: "喝水", repeat: "daily", due: "2026-09-01" }).todo;
    const first = service.habitCheckin({ id: created.id, date: "2026-09-01", note: "done" });
    const duplicate = service.habitCheckin({ id: created.id, date: "2026-09-01" });
    const second = service.habitCheckin({ id: created.id, date: "2026-09-02" });

    assert.equal(first.todo.status, "pending");
    assert.equal(first.todo.due, "2026-09-02");
    assert.equal(duplicate.duplicate, true);
    assert.equal(second.todo.habitCompletionCount, 2);
    assert.equal(second.todo.habitStreak, 2);
    assert.equal(service.getById(created.id).status, "pending");
    assert.match(fs.readFileSync(path.join(tempDir, "todo-events.jsonl"), "utf8"), /habit_completed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("acknowledged supervision can be re-armed with a new version", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-supervision-"));
  try {
    const service = createService(tempDir);
    const created = service.create({ title: "每两天出门" }).todo;
    const supervised = service.superviseStart({ id: created.id, checkIntervalMin: 60 }).todo;
    const previousVersion = supervised.version;
    const result = service.rearmSupervision({
      id: created.id,
      expectedVersion: previousVersion,
      nowMs: Date.parse("2026-09-01T08:00:00Z"),
    });

    assert.equal(result.error, null);
    assert.equal(result.nextCheckAt, "2026-09-01T09:00:00.000Z");
    assert.equal(result.todo.version, previousVersion + 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
