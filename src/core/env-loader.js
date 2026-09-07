const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

function resolveEnvCandidates({ cwd = process.cwd(), env = process.env } = {}) {
  const explicit = normalizePath(env.CYBERBOSS_ENV_FILE, cwd);
  const userConfig = path.join(os.homedir(), ".cyberboss", ".env");
  const legacyProjectFile = path.join(cwd, ".env");
  return [...new Set([explicit, userConfig, legacyProjectFile].filter(Boolean))];
}

function loadCyberbossEnv(options = {}) {
  for (const filePath of resolveEnvCandidates(options)) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    dotenv.config({ path: filePath });
    return filePath;
  }
  return "";
}

function normalizePath(value, cwd) {
  const normalized = String(value || "").trim();
  return normalized ? path.resolve(cwd, normalized) : "";
}

module.exports = {
  loadCyberbossEnv,
  resolveEnvCandidates,
};
