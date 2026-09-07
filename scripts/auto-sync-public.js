#!/usr/bin/env node

const childProcess = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

function git(args, options = {}) {
  return childProcess.execFileSync("git", ["-c", "safe.directory=*", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  }).trim();
}

function config(name, fallback = "") {
  try {
    return git(["config", "--get", name]) || fallback;
  } catch {
    return fallback;
  }
}

function runNpm(args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  childProcess.execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    // Windows executes .cmd shims through cmd.exe; execFileSync cannot launch
    // them directly and otherwise fails with EINVAL from a Git hook.
    shell: process.platform === "win32",
  });
}

try {
  if (config("cyberboss.publicSync") !== "true") {
    process.exit(0);
  }
  const branch = git(["branch", "--show-current"]);
  const expectedBranch = config("cyberboss.publicSourceBranch", "master");
  if (branch !== expectedBranch) {
    process.stdout.write(`Public sync skipped: current branch is ${branch || "detached"}.\n`);
    process.exit(0);
  }
  runNpm(["run", "check"]);
  runNpm(["test"]);
  const localBranch = config("cyberboss.publicLocalBranch", "public-main");
  childProcess.execFileSync(process.execPath, [
    path.join(root, "scripts", "update-public-branch.js"),
    "--from-ref", "HEAD",
    "--branch", localBranch,
  ], {
    cwd: root,
    stdio: "inherit",
  });
  git([
    "push",
    config("cyberboss.publicRemote", "origin"),
    `${localBranch}:${config("cyberboss.publicRemoteBranch", "main")}`,
  ], { inherit: true });
} catch (error) {
  process.stderr.write(`Public sync skipped: ${error.message}\n`);
  process.exitCode = 0;
}
