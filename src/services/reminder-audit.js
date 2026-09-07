const fs = require("fs");
const path = require("path");

/**
 * Append-only audit trail for reminder lifecycle events.
 * Written to {stateDir}/logs/reminder-audit.jsonl — never read by the model;
 * exists purely for troubleshooting (e.g. why a reminder fired at the wrong time).
 */
class ReminderAudit {
  constructor({ logFile }) {
    this.logFile = logFile;
  }

  write(entry) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      });
      fs.appendFileSync(this.logFile, line + "\n", "utf8");
    } catch {
      // audit must never break the reminder pipeline
    }
  }
}

module.exports = { ReminderAudit };
