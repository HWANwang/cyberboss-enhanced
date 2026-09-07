#!/usr/bin/env node

const childProcess = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function readFlag(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : fallback;
}

function git(args) {
  childProcess.execFileSync("git", ["-c", "safe.directory=*", ...args], {
    cwd: root,
    stdio: "inherit",
  });
}

const remote = readFlag("--remote", "origin");
const remoteBranch = readFlag("--branch", "main");
const sourceBranch = readFlag("--source-branch", git(["branch", "--show-current"]));
git(["config", "core.hooksPath", ".githooks"]);
git(["config", "cyberboss.publicRemote", remote]);
git(["config", "cyberboss.publicRemoteBranch", remoteBranch]);
git(["config", "cyberboss.publicLocalBranch", "public-main"]);
git(["config", "cyberboss.publicSourceBranch", sourceBranch]);
git(["config", "cyberboss.publicSync", "false"]);
process.stdout.write(`Installed publication hooks. Source=${sourceBranch}, remote=${remote}, remote branch=${remoteBranch}. Automatic push remains disabled.\n`);
