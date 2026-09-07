const path = require("path");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { createTimelineIntegration } = require("../integrations/timeline");
const { ChannelFileService } = require("../services/channel-file-service");
const { DiaryService } = require("../services/diary-service");
const { ReminderService } = require("../services/reminder-service");
const { SystemMessageService } = require("../services/system-message-service");
const { TimelineService } = require("../services/timeline-service");
const { TodoService } = require("../services/todo-service");
const { MemoryService } = require("../services/memory-service");
const { RuntimeContextStore } = require("./runtime-context-store");
const { ProjectToolHost } = require("./tool-host");
const { WhereaboutsService } = require("whereabouts-mcp");

function createProjectTooling(config, options = {}) {
  const sessionStore = options.sessionStore || new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const channelAdapter = options.channelAdapter || createWeixinChannelAdapter(config);
  const timelineIntegration = options.timelineIntegration || createTimelineIntegration(config);
  const runtimeContextStore = options.runtimeContextStore || new RuntimeContextStore({
    filePath: config.projectToolContextFile,
  });
  const channelFile = new ChannelFileService({ config, channelAdapter, sessionStore });
  const todo = new TodoService({
    filePath: path.join(config.stateDir, "todos.json"),
    eventsFilePath: path.join(config.stateDir, "logs", "todo-events.jsonl"),
  });
  const services = {
    diary: new DiaryService({ config }),
    reminder: new ReminderService({ config, sessionStore, todoService: todo }),
    system: new SystemMessageService({ config, sessionStore }),
    channelFile,
    timeline: new TimelineService({ config, timelineIntegration, sessionStore }),
    todo,
    memory: new MemoryService({
      spaces: {
        memory: { filePath: path.join(config.stateDir, "memory", "MEMORY.md") },
        career: { filePath: path.join(config.stateDir, "memory", "CAREER.md") },
      },
    }),
    whereabouts: new WhereaboutsService({
      config: {
        storeFile: config.locationStoreFile,
        host: config.locationHost,
        port: config.locationPort,
        token: config.locationToken,
        historyLimit: config.locationHistoryLimit,
        movementEventLimit: config.locationMovementEventLimit,
        batteryHistoryLimit: config.locationBatteryHistoryLimit,
        knownPlaces: config.locationKnownPlaces,
        knownPlaceRadiusMeters: config.locationKnownPlaceRadiusMeters,
        stayMergeRadiusMeters: config.locationStayMergeRadiusMeters,
        stayBreakConfirmRadiusMeters: config.locationStayBreakConfirmRadiusMeters,
        stayBreakConfirmSamples: config.locationStayBreakConfirmSamples,
        majorMoveThresholdMeters: config.locationMajorMoveThresholdMeters,
      },
    }),
  };
  const toolHost = new ProjectToolHost({
    services,
    runtimeContextStore,
    excludeToolTopics: parseExcludedToolTopics(config),
  });
  return {
    services,
    toolHost,
    runtimeContextStore,
  };
}

module.exports = { createProjectTooling };

function parseExcludedToolTopics(config) {
  // Read from CYBERBOSS_EXCLUDED_TOOL_TOPICS env var, comma-separated
  // Values: sticker, location, timeline
  const raw = String(process.env.CYBERBOSS_EXCLUDED_TOOL_TOPICS || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
