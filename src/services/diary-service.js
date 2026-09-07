const fs = require("fs");
const path = require("path");

const { resolveBodyInput } = require("./text-input");

class DiaryService {
  constructor({ config }) {
    this.config = config;
  }

  async append({ text = "", textFile = "", title = "", date = "", time = "" } = {}) {
    const body = await resolveBodyInput({ text, textFile });
    if (!body) {
      throw new Error("Diary content cannot be empty. Pass text or textFile.");
    }

    const now = new Date();
    const dateString = date || formatDate(now);
    const timeString = time || formatTime(now);
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    const entry = buildDiaryEntry({
      timeString,
      title,
      body,
    });

    fs.mkdirSync(this.config.diaryDir, { recursive: true });
    const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? "\n\n" : "";
    fs.appendFileSync(filePath, `${prefix}${entry}`, "utf8");
    return {
      filePath,
      date: dateString,
      time: timeString,
      body,
    };
  }

  async read({ date = "", from = "", to = "", limit = 0 } = {}) {
    const now = new Date();
    // Range read: merge multiple days, each day's content capped by limit.
    if (from || to) {
      return this._readRange({ from, to, limit });
    }
    const dateString = date || formatDate(now);
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    if (!fs.existsSync(filePath)) {
      return { filePath, date: dateString, content: "", exists: false };
    }
    let content = fs.readFileSync(filePath, "utf8");
    if (Number.isInteger(limit) && limit > 0) {
      content = content.slice(0, limit * 100);
    }
    return { filePath, date: dateString, content, exists: true };
  }

  _readRange({ from = "", to = "", limit = 0 }) {
    const fromDate = parseDateString(from);
    const toDate = parseDateString(to) || fromDate;
    if (!fromDate) {
      throw new Error("from is required for range reads (YYYY-MM-DD).");
    }
    const days = [];
    const cursor = new Date(fromDate);
    const end = new Date(toDate);
    while (cursor <= end) {
      const dateString = formatDate(cursor);
      const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
      if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, "utf8");
        if (Number.isInteger(limit) && limit > 0 && content.length > limit * 100) {
          content = `${content.slice(0, limit * 100)}\n…(trimmed)`;
        }
        days.push({ date: dateString, content });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    const merged = days.map((d) => `## ${d.date}\n\n${d.content.trim()}`).join("\n\n");
    return {
      from: formatDate(fromDate),
      to: formatDate(end),
      days: days.map((d) => d.date),
      content: merged,
      exists: days.length > 0,
    };
  }

  async edit({ date = "", search = "", new_text = "", mode = "replace" } = {}) {
    const now = new Date();
    const dateString = date || formatDate(now);
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);

    if (!fs.existsSync(filePath)) {
      if (mode === "write") {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, `${String(new_text || "").trim()}\n`, "utf8");
        return { filePath, date: dateString, mode, modified: true };
      }
      throw new Error(`No diary entry for ${dateString}.`);
    }
    if (!search && mode !== "append" && mode !== "write") {
      throw new Error("search text is required for replace/delete/replace_block/delete_block mode.");
    }
    if (!new_text && mode !== "delete" && mode !== "delete_block") {
      throw new Error("new_text is required for replace/append/replace_block/write mode.");
    }

    let content = fs.readFileSync(filePath, "utf8");

    if (mode === "write") {
      fs.writeFileSync(filePath, `${new_text.trim()}\n`, "utf8");
      return { filePath, date: dateString, mode, modified: true };
    }

    if (mode === "append") {
      const prefix = content.endsWith("\n") ? "" : "\n\n";
      content += `${prefix}${new_text}`;
    } else if (mode === "delete_block" || mode === "replace_block") {
      const block = _findBlockAt(content, search);
      if (!block) {
        throw new Error(`Could not find a diary block containing "${search}".`);
      }
      const before = content.slice(0, block.startIndex);
      const after = content.slice(block.endIndex);
      const replacement = mode === "replace_block" ? `\n\n${new_text}` : "";
      content = _cleanGaps(`${before}${replacement}${after}`);
    } else if (mode === "delete") {
      if (!content.includes(search)) {
        throw new Error(`Could not find "${search}" in diary.`);
      }
      content = _cleanGaps(content.replace(search, ""));
    } else if (mode === "replace") {
      if (!content.includes(search)) {
        throw new Error(`Could not find "${search}" in diary to replace.`);
      }
      content = _cleanGaps(content.replace(search, new_text));
    }

    fs.writeFileSync(filePath, content, "utf8");
    return { filePath, date: dateString, mode, modified: true };
  }
}

function buildDiaryEntry({ timeString, title, body }) {
  const heading = title ? `## ${timeString} ${String(title).trim()}` : `## ${timeString}`;
  return `${heading}\n\n${body}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function parseDateString(value) {
  const normalized = String(value || "").trim();
  const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return null;
  }
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

module.exports = {
  DiaryService,
  buildDiaryEntry,
  formatDate,
  formatTime,
};

/**
 * Find the diary block (## heading + its content) that contains searchText.
 * Returns { startIndex, endIndex } or null.
 */
function _findBlockAt(content, searchText) {
  const idx = content.indexOf(searchText);
  if (idx === -1) return null;

  const before = content.slice(0, idx);
  // Find the last ## heading before the search match
  const headingMatch = before.match(/\n## /g);
  const lastHeading = headingMatch ? before.lastIndexOf("\n## ") : 0;
  const startIndex = lastHeading > 0 ? lastHeading + 1 : 0; // include the \n or start

  // Find the next ## heading after the search match
  const after = content.slice(idx + searchText.length);
  const nextHeading = after.search(/\n(?=## )/);
  const endIndex = nextHeading >= 0
    ? idx + searchText.length + nextHeading + 1  // include the \n
    : content.length;

  return { startIndex, endIndex };
}

/**
 * Clean up excessive blank lines caused by edit operations.
 * Max 1 blank line between blocks, no trailing whitespace.
 */
function _cleanGaps(text) {
  return String(text || "")
    .replace(/\n{3,}/g, "\n\n")    // max 1 blank line
    .replace(/^\n+/, "")           // no leading blank lines
    .replace(/\n+$/, "\n");        // exactly one trailing newline
}
