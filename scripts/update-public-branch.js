#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const fromRef = readFlag("--from-ref");
const fromWorktree = args.includes("--from-worktree");
const squash = args.includes("--squash");
const branch = readFlag("--branch", "public-main");

if (Boolean(fromRef) === fromWorktree) {
  throw new Error("Choose exactly one source: --from-ref <commit> or --from-worktree.");
}

function readFlag(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : fallback;
}

function git(args, options = {}) {
  return childProcess.execFileSync("git", ["-c", "safe.directory=*", ...args], {
    cwd: root,
    encoding: "utf8",
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runAudit(auditArgs) {
  childProcess.execFileSync(process.execPath, [path.join(root, "scripts", "publication-audit.js"), ...auditArgs], {
    cwd: root,
    stdio: "inherit",
  });
}

function buildWorktreeTree() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-public-index-"));
  const indexFile = path.join(tempDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    git(["read-tree", "--empty"], { env });
    git(["add", "-A", "--", "."], { env });
    return git(["write-tree"], { env });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolvePreviousCommit() {
  try {
    return git(["rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    return "";
  }
}

function createPublicCommit(tree, parent, message) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Cyberboss Maintainers",
    GIT_AUTHOR_EMAIL: "maintainers@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Cyberboss Maintainers",
    GIT_COMMITTER_EMAIL: "maintainers@users.noreply.github.com",
  };
  const commitArgs = ["commit-tree", tree, "-m", message];
  if (parent) commitArgs.push("-p", parent);
  return git(commitArgs, { env });
}

try {
  const tree = fromWorktree
    ? (runAudit(["--include-untracked"]), buildWorktreeTree())
    : (runAudit(["--ref", fromRef]), git(["rev-parse", `${fromRef}^{tree}`]));
  const previous = squash ? "" : resolvePreviousCommit();
  const sourceLabel = fromWorktree ? "working tree" : fromRef;
  const commit = createPublicCommit(tree, previous, `chore: public snapshot from ${sourceLabel}`);
  const updateArgs = ["update-ref", `refs/heads/${branch}`, commit];
  if (previous) updateArgs.push(previous);
  git(updateArgs);
  process.stdout.write(`Updated ${branch} at ${commit}. No remote was contacted.\n`);
} catch (error) {
  process.stderr.write(`Could not update public branch: ${error.message}\n`);
  process.exitCode = 1;
}
