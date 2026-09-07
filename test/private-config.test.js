const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

const { readConfig } = require("../src/core/config");
const { resolveEnvCandidates } = require("../src/core/env-loader");

test("private instruction and operation files default outside the source checkout", () => {
  const original = {
    CYBERBOSS_STATE_DIR: process.env.CYBERBOSS_STATE_DIR,
    CYBERBOSS_PRIVATE_DIR: process.env.CYBERBOSS_PRIVATE_DIR,
    CYBERBOSS_WEIXIN_INSTRUCTIONS_FILE: process.env.CYBERBOSS_WEIXIN_INSTRUCTIONS_FILE,
    CYBERBOSS_WEIXIN_OPERATIONS_FILE: process.env.CYBERBOSS_WEIXIN_OPERATIONS_FILE,
  };
  const stateDir = path.join(os.tmpdir(), "cyberboss-private-config-test");
  try {
    process.env.CYBERBOSS_STATE_DIR = stateDir;
    delete process.env.CYBERBOSS_PRIVATE_DIR;
    delete process.env.CYBERBOSS_WEIXIN_INSTRUCTIONS_FILE;
    delete process.env.CYBERBOSS_WEIXIN_OPERATIONS_FILE;
    const config = readConfig();
    assert.equal(config.privateDir, path.join(stateDir, "private"));
    assert.equal(config.weixinInstructionsFile, path.join(stateDir, "private", "weixin-instructions.md"));
    assert.equal(config.weixinOperationsFile, path.join(stateDir, "private", "weixin-operations.md"));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("explicit external env file is the first configuration candidate", () => {
  const explicit = path.join(os.tmpdir(), "cyberboss-explicit.env");
  const candidates = resolveEnvCandidates({ cwd: path.join(os.tmpdir(), "workspace"), env: { CYBERBOSS_ENV_FILE: explicit } });
  assert.equal(candidates[0], explicit);
});
