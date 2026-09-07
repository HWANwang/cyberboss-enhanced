#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const ref = readFlag("--ref");
const mode = ref ? "ref" : args.has("--staged") ? "staged" : "worktree";
const includeUntracked = args.has("--include-untracked");

const blockedPathPatterns = [
  { id: "private-environment-file", pattern: /(^|\/)\.env($|\.)/i, allow: (file) => file === ".env.example" },
  { id: "local-codex-config", pattern: /(^|\/)\.codex(\/|$)/i },
  { id: "runtime-state", pattern: /(^|\/)(state|private|logs|tmp)(\/|$)/i },
  { id: "dependency-directory", pattern: /(^|\/)node_modules(\/|$)/i },
  { id: "private-demo-artifact", pattern: /(^|\/)(timeline-full-test\.png|nul)$/i },
];

const contentPatterns = [
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { id: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "local-user-path", pattern: /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s]+|\/(?:Users|home)\/[^/\s]+)/ },
  { id: "wechat-bot-account", pattern: /\b[a-f0-9]{8,}-im\.bot\b/i },
  {
    id: "private-persona-marker",
    pattern: new RegExp([
      "欢" + "儿",
      "H" + "WAN",
      "脱" + "毛",
      "排" + "便",
      "称" + "重",
      "米诺" + "地尔",
      "微信" + "读书",
      "揉" + "鼻子",
    ].join("|"), "i"),
  },
];

function git(args, input = undefined, encoding = "utf8") {
  return childProcess.execFileSync("git", ["-c", "safe.directory=*", ...args], {
    cwd: root,
    encoding,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function readFlag(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || "").trim() : "";
}

function listCandidates() {
  if (mode === "ref") {
    return splitNull(git(["ls-tree", "-r", "--name-only", "-z", ref]));
  }
  if (mode === "staged") {
    return splitNull(git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]));
  }
  const tracked = splitNull(git(["ls-files", "-z"]));
  if (!includeUntracked) {
    return tracked;
  }
  const untracked = splitNull(git(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])];
}

function splitNull(value) {
  return String(value || "").split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));
}

function readCandidate(file) {
  if (mode === "ref") {
    try {
      return git(["show", `${ref}:${file}`], undefined, null);
    } catch {
      return Buffer.alloc(0);
    }
  }
  if (mode === "staged") {
    try {
      return git(["show", `:${file}`]);
    } catch {
      return "";
    }
  }
  try {
    return fs.readFileSync(path.join(root, file));
  } catch {
    return Buffer.alloc(0);
  }
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function audit() {
  const findings = [];
  for (const file of listCandidates()) {
    for (const rule of blockedPathPatterns) {
      if (rule.pattern.test(file) && !rule.allow?.(file)) {
        findings.push({ file, rule: rule.id });
      }
    }
    const raw = readCandidate(file);
    if (!raw.length || isBinary(raw)) {
      continue;
    }
    const content = raw.toString("utf8");
    for (const rule of contentPatterns) {
      if (rule.pattern.test(content)) {
        findings.push({ file, rule: rule.id });
      }
    }
  }
  return findings;
}

try {
  const findings = audit();
  if (findings.length) {
    process.stderr.write("Publication audit blocked potential private content:\n");
    for (const finding of findings) {
      process.stderr.write(`- ${finding.file} [${finding.rule}]\n`);
    }
    process.exitCode = 1;
  } else {
    const target = mode === "ref" ? `ref ${ref}` : mode;
    const untrackedNote = mode !== "ref" && includeUntracked ? ", including untracked files" : "";
    process.stdout.write(`Publication audit passed (${target}${untrackedNote}).\n`);
  }
} catch (error) {
  process.stderr.write(`Publication audit failed to run: ${error.message}\n`);
  process.exitCode = 2;
}
