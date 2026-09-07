const fs = require("fs");
const path = require("path");

const MIN_REASON_CHARS = 10;

const DEFAULT_SPACES = {
  memory: {
    filePath: "",
    maxEntryChars: 400,
    maxFileChars: 3000,
    requireReason: true,
  },
  career: {
    filePath: "",
    maxEntryChars: 1000,
    maxFileChars: 10000,
    requireReason: false,
  },
};

/**
 * MemoryService — multi-space long-term memory for Cyberboss.
 *
 * Each space is an independent markdown file with its own size limits and
 * write rules, sharing the same read/append/edit implementation:
 *   - memory: the user's long-term memory (MEMORY.md). Append requires a
 *     durabilityReason (why it still matters in 3 months); the reason is
 *     validated but NEVER persisted.
 *   - career: career material archive (CAREER.md). No durabilityReason;
 *     loaded on demand only (resume writing / interview prep / career talk).
 *
 * space is an enum — callers can never pass arbitrary paths.
 */
class MemoryService {
  constructor({ spaces = {} } = {}) {
    this.spaces = {};
    for (const [key, spec] of Object.entries(DEFAULT_SPACES)) {
      const provided = spaces[key] && typeof spaces[key] === "object" ? spaces[key] : {};
      this.spaces[key] = {
        filePath: String(provided.filePath || spec.filePath || ""),
        maxEntryChars: Number.isFinite(Number(provided.maxEntryChars))
          ? Number(provided.maxEntryChars)
          : spec.maxEntryChars,
        maxFileChars: Number.isFinite(Number(provided.maxFileChars))
          ? Number(provided.maxFileChars)
          : spec.maxFileChars,
        requireReason: provided.requireReason !== undefined
          ? !!provided.requireReason
          : spec.requireReason,
      };
    }
    this.queues = {};
  }

  listSpaces() {
    return Object.keys(this.spaces).filter((key) => this.spaces[key].filePath);
  }

  _resolveSpace(space = "memory") {
    const key = String(space || "").trim().toLowerCase();
    return this.spaces[key] || null;
  }

  _readRaw(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  }

  _writeRaw(filePath, content) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
  }

  _enqueue(spaceKey, fn) {
    if (!this.queues[spaceKey]) {
      this.queues[spaceKey] = Promise.resolve();
    }
    const run = this.queues[spaceKey].then(fn, fn);
    this.queues[spaceKey] = run.catch(() => {});
    return run;
  }

  read({ space = "memory" } = {}) {
    const spec = this._resolveSpace(space);
    if (!spec) {
      return { ok: false, error: `Unknown memory space: ${space}` };
    }
    const content = this._readRaw(spec.filePath).trim();
    return {
      ok: true,
      space: spaceKeyOf(spec, this),
      exists: content.length > 0,
      chars: content.length,
      content,
    };
  }

  append({ space = "memory", text = "", section = "", durabilityReason = "" } = {}) {
    const spec = this._resolveSpace(space);
    if (!spec) {
      return { ok: false, error: `Unknown memory space: ${space}` };
    }
    const spaceKey = spaceKeyOf(spec, this);
    return this._enqueue(spaceKey, () => {
      const clean = String(text || "").trim();
      if (!clean) {
        return { ok: false, error: "text is required" };
      }
      if (clean.length > spec.maxEntryChars) {
        return {
          ok: false,
          error: `entry too long (${clean.length} chars, max ${spec.maxEntryChars})`,
        };
      }
      if (spec.requireReason) {
        const reason = String(durabilityReason || "").trim();
        if (!reason) {
          return {
            ok: false,
            error: "durabilityReason is required: explain why this stays useful in 3 months",
          };
        }
        if (reason.length < MIN_REASON_CHARS) {
          return {
            ok: false,
            error: `durabilityReason too vague (${reason.length} chars, need >= ${MIN_REASON_CHARS})`,
          };
        }
      }
      const current = this._readRaw(spec.filePath);
      if (current.length > spec.maxFileChars) {
        return {
          ok: false,
          overLimit: true,
          error: `memory space "${spaceKey}" is full (${current.length} chars, max ${spec.maxFileChars}). Review and clean outdated entries with the edit tool before appending.`,
        };
      }
      const heading = String(section || "").trim();
      let next = current;
      if (heading) {
        const headingLine = `## ${heading}`;
        const hasHeading = next.includes(headingLine);
        next = next.trimEnd() + (next.trimEnd() ? "\n\n" : "") + headingLine + "\n\n";
        if (hasHeading) {
          // insert right after the existing heading block
          next = insertUnderHeading(next, headingLine, clean);
        } else {
          next += `${clean}\n`;
        }
      } else {
        next = next.trimEnd() + (next.trimEnd() ? "\n\n" : "") + clean + "\n";
      }
      this._writeRaw(spec.filePath, next);
      return { ok: true, space: spaceKey, chars: next.length };
    });
  }

  edit({ space = "memory", mode = "replace", search = "", new_text = "" } = {}) {
    const spec = this._resolveSpace(space);
    if (!spec) {
      return { ok: false, error: `Unknown memory space: ${space}` };
    }
    const spaceKey = spaceKeyOf(spec, this);
    return this._enqueue(spaceKey, () => {
      const op = String(mode || "").trim().toLowerCase();
      const needle = String(search || "");
      const replacement = String(new_text ?? "");
      if (!needle) {
        return { ok: false, error: "search is required" };
      }
      if (op !== "delete" && !replacement) {
        return { ok: false, error: "new_text is required for replace" };
      }
      const content = this._readRaw(spec.filePath);
      if (!content.includes(needle)) {
        return { ok: false, error: `not found: ${needle.slice(0, 40)}` };
      }
      const next = op === "delete" ? content.replace(needle, "") : content.replace(needle, replacement);
      this._writeRaw(spec.filePath, next);
      return { ok: true, space: spaceKey, modified: content !== next };
    });
  }
}

function spaceKeyOf(spec, service) {
  for (const [key, candidate] of Object.entries(service.spaces)) {
    if (candidate.filePath === spec.filePath) {
      return key;
    }
  }
  return "memory";
}

function insertUnderHeading(content, headingLine, text) {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((line) => line.trim() === headingLine);
  if (headingIdx < 0) {
    return content;
  }
  let endIdx = headingIdx + 1;
  while (endIdx < lines.length) {
    const trimmed = lines[endIdx].trim();
    if (trimmed.startsWith("## ")) {
      break;
    }
    endIdx += 1;
  }
  // insert after the last non-empty line of the heading's block
  let insertAt = endIdx;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") {
    insertAt -= 1;
  }
  const block = lines.slice(headingIdx + 1, insertAt).join("\n");
  const separator = block.trim() ? "\n" : "";
  lines.splice(insertAt, 0, `${separator}${text}`);
  return lines.join("\n");
}

module.exports = { MemoryService };
