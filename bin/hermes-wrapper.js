const { spawn } = require("child_process");

const python = String(process.env.CYBERBOSS_HERMES_PYTHON || "python").trim();
const script = String(process.env.CYBERBOSS_HERMES_SCRIPT || "hermes").trim();
const args = process.argv.slice(2);

if (!python || !script) {
  throw new Error("Set CYBERBOSS_HERMES_PYTHON and CYBERBOSS_HERMES_SCRIPT to run a custom Hermes installation.");
}

const child = spawn(python, [script, ...args], { stdio: "inherit", windowsHide: true });
child.on("error", (error) => {
  process.stderr.write(`Unable to start Hermes: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
