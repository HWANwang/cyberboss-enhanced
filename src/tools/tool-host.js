
class ProjectToolHost {
  constructor({ services, runtimeContextStore, excludeToolTopics = [] }) {
    this.services = services;
    this.runtimeContextStore = runtimeContextStore;
    this.excludeTopics = new Set(
      Array.isArray(excludeToolTopics)
        ? excludeToolTopics.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        : [],
    );
  }

  listTools() {
    const filtered = PROJECT_TOOLS.filter(
      (tool) => !tool.topics?.some((topic) => this.excludeTopics.has(topic)),
    );
    const builtIn = filtered.map((tool) => ({
      name: tool.name,
      description: buildToolDescription(tool),
      inputSchema: tool.inputSchema,
    }));
    return builtIn;
  }

  async invokeTool(toolName, args = {}, context = {}) {
    const spec = PROJECT_TOOLS.find((candidate) => candidate.name === toolName);
    const normalizedArgs = args && typeof args === "object" ? args : {};
    if (spec) {
      validateSchema(spec.inputSchema, normalizedArgs, toolName, "input");
      const resolvedContext = this.resolveContext(context);
      return await spec.handler({
        services: this.services,
        args: normalizedArgs,
        context: resolvedContext,
      });
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  resolveContext(context = {}) {
    const explicitWorkspaceRoot = normalizeText(context.workspaceRoot);
    const explicitRuntimeId = normalizeText(context.runtimeId);
    const active = this.runtimeContextStore.resolveActiveContext({
      workspaceRoot: explicitWorkspaceRoot,
      runtimeId: explicitRuntimeId,
    }) || {};
    return {
      runtimeId: explicitRuntimeId || normalizeText(active.runtimeId),
      workspaceRoot: explicitWorkspaceRoot || normalizeText(active.workspaceRoot),
      threadId: normalizeText(context.threadId) || normalizeText(active.threadId),
      bindingKey: normalizeText(context.bindingKey) || normalizeText(active.bindingKey),
      accountId: normalizeText(context.accountId) || normalizeText(active.accountId),
      senderId: normalizeText(context.senderId) || normalizeText(active.senderId),
    };
  }
}

function listProjectToolNames() {
  return PROJECT_TOOLS.map((tool) => tool.name);
}

const PROJECT_TOOLS = [
  {
    name: "cyberboss_diary_append",
    description: "Append a diary entry into Cyberboss local diary storage.",
    shortHint: "Append a diary entry with direct text content.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Diary body to append." },
        title: { type: "string", description: "Optional short entry title." },
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
        time: { type: "string", description: "Optional time in HH:mm." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.append(args);
      return {
        text: `Diary saved. Do NOT echo or summarize the diary text in your reply. Reply to the user naturally without mentioning what you just recorded.`,
        data: { filePath: result.filePath, date: result.date, time: result.time },
      };
    },
  },
  {
    name: "cyberboss_diary_read",
    description: "Read diary entries for a specific date (YYYY-MM-DD), or a date range via from/to (merged day by day). Omit date to read today. Pass limit to cap each day's content.",
    shortHint: "Read diary entries, optionally a date range.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date in YYYY-MM-DD (default: today)." },
        from: { type: "string", description: "Range start YYYY-MM-DD (use with to)." },
        to: { type: "string", description: "Range end YYYY-MM-DD (defaults to from)." },
        limit: { type: "integer", description: "Optional cap per day (approx chars/100)." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.read(args);
      if (!result.exists) {
        return {
          text: `No diary entry for ${result.date}.`,
          data: result,
        };
      }
      return {
        text: `Diary for ${result.date}:`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_diary_edit",
    description: "Edit diary content for a specific date. Modes: write (overwrites the entire day's diary with new_text — use for nightly summary or full rewrite), replace (finds search text and replaces it), delete (removes search text), append (adds text at end), replace_block (finds a diary section by text inside it and replaces the entire section), delete_block (finds a diary section by text inside it and deletes the entire section). Block modes work at the ## heading level and are safer for removing/rewriting whole entries. For all modes, excess blank lines are automatically cleaned up.",
    shortHint: "Edit diary entries: write, replace, delete, append, or block ops.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      required: [],
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD (default: today)." },
        search: { type: "string", description: "Text to find (required for replace/delete mode). The first match will be affected." },
        new_text: { type: "string", description: "Replacement text (required for replace/append mode)." },
        mode: { type: "string", description: "Operation mode: write (overwrites entire day's diary), replace (default, replaces search with new_text), delete (removes search text), append (adds new_text at end), replace_block (replaces entire section containing search), delete_block (deletes entire section containing search)." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.edit(args);
      return {
        text: `Diary ${result.mode}d.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_reminder_create",
    description: "Create a reminder in Cyberboss. Two kinds: fixed_time (default — plain time reminder like delivery/food/medicine) and todo_check (supervised follow-up on a todo; auto-cancelled if the todo completes or its plan changes). Absolute dueAt MUST include a timezone (e.g. 2026-08-20T21:30+08:00 or ...Z). Use delayMinutes for relative times. Pass dedupeKey to prevent duplicate queueing.",
    shortHint: "Create a fixed_time or todo_check reminder.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Reminder text to send back later." },
        kind: { type: "string", description: "fixed_time (default) or todo_check." },
        delayMinutes: { type: "integer", description: "Minutes from now before the reminder fires." },
        dueAt: { type: "string", description: "Absolute time WITH timezone such as 2026-04-07T21:30+08:00." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
        sourceTodoId: { type: "string", description: "For todo_check: the todo id being supervised." },
        todoVersion: { type: "integer", description: "For todo_check: the todo's version at arming time." },
        dedupeKey: { type: "string", description: "Prevents duplicate queueing for the same purpose (e.g. todo:todo_001)." },
        recurrence: { type: "string", description: "Optional recurrence hint: daily, weekly, or empty." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.reminder.create(args, context);
      const warnings = Array.isArray(result.warnings) && result.warnings.length
        ? ` Warning: ${result.warnings.join("; ")}`
        : "";
      return {
        text: `Reminder queued: ${result.id}${result.duplicate ? " (duplicate skipped)" : ""}${warnings}`,
        data: {
          id: result.id,
          kind: result.kind,
          dueAtMs: result.dueAtMs,
          dueAtPreview: result.dueAtPreview,
          duplicate: !!result.duplicate,
          warnings: result.warnings || [],
        },
      };
    },
  },
  {
    name: "cyberboss_reminder_list",
    description: "List reminders with filters. Default: active (scheduled/fired) reminders. Filter by status (scheduled,fired,acknowledged,cancelled,expired), date (YYYY-MM-DD), sourceTodoId, or exact id.",
    shortHint: "List reminders by status/date/todo.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Exact reminder id." },
        status: { type: "string", description: "Comma-separated statuses: scheduled,fired,acknowledged,cancelled,expired. Default: scheduled,fired." },
        date: { type: "string", description: "Filter by due date YYYY-MM-DD." },
        sourceTodoId: { type: "string", description: "Filter by todo id." },
        limit: { type: "integer", description: "Max rows to return." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const items = services.reminder.list(args);
      const text = items.length
        ? `Reminders: ${items.length}.`
        : "No reminders match.";
      return { text, data: { reminders: items, count: items.length } };
    },
  },
  {
    name: "cyberboss_reminder_update",
    description: "Manage a reminder: cancel (stop it), ack (confirm a fired reminder was handled), or reschedule (new time via delayMinutes or dueAt with timezone).",
    shortHint: "Cancel / ack / reschedule a reminder.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["id", "action"],
      properties: {
        id: { type: "string", description: "Reminder id." },
        action: { type: "string", description: "cancel, ack, or reschedule." },
        delayMinutes: { type: "integer", description: "For reschedule: minutes from now." },
        dueAt: { type: "string", description: "For reschedule: absolute time WITH timezone (e.g. 2026-08-20T21:30+08:00)." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.reminder.update(args);
      if (!result.ok) {
        return { text: `Failed: ${result.error}`, data: result };
      }
      return { text: `Reminder ${result.action}: ${result.id}`, data: result };
    },
  },
  {
    name: "cyberboss_system_send",
    description: "Queue an internal Cyberboss system trigger for the current bound workspace and chat.",
    shortHint: "Queue an internal system message for the current workspace.",
    topics: ["system"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        workspaceRoot: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = services.system.queueMessage(args, context);
      return {
        text: `System message queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_channel_send_file",
    description: "Send an existing local file back to the current WeChat chat.",
    shortHint: "Send a local file back to the current WeChat user.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.channelFile.sendToCurrentChat(args, context);
      return {
        text: `File sent: ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_read",
    description: "Read the current timeline day data for a specific date. Use this before editing when the current day state is uncertain. Pass limit to cap how many events are returned.",
    shortHint: "Read a timeline day before editing it.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
        limit: { type: "integer", description: "Optional cap on events returned (e.g. 50)." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.read(args);
      const exists = !!result?.data?.exists;
      const eventCount = Number.isInteger(result?.data?.eventCount) ? result.data.eventCount : 0;
      return {
        text: `Timeline day ${args.date}: ${exists ? `${eventCount} events` : "missing"}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_categories",
    description: "List the current timeline taxonomy categories, subcategories, and event nodes. Use this before choosing category ids or event nodes.",
    shortHint: "Inspect the current timeline taxonomy before choosing category ids or event nodes.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.timeline.listCategories();
      const categoryCount = Number.isInteger(result?.data?.categoryCount) ? result.data.categoryCount : 0;
      return {
        text: `Timeline categories loaded: ${categoryCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_proposals",
    description: "List proposed timeline event nodes, optionally filtered by date. Use this when deciding whether a new event node is actually needed.",
    shortHint: "Inspect proposed timeline event nodes before introducing new taxonomy.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.listProposals(args);
      const proposalCount = Number.isInteger(result?.data?.proposalCount) ? result.data.proposalCount : 0;
      return {
        text: `Timeline proposals loaded: ${proposalCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_write",
    description: "Write timeline events through timeline-for-agent. Inspect the current day and taxonomy first when category ids, event nodes, or existing events are uncertain.",
    shortHint: "Write timeline events after checking the current day and taxonomy when needed.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date", "events"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
        events: {
          type: "array",
          description: "Timeline events for the target date.",
          items: {
            type: "object",
            required: ["startAt", "endAt"],
            properties: {
              id: { type: "string" },
              startAt: { type: "string", description: "ISO datetime within the target date." },
              endAt: { type: "string", description: "ISO datetime within the target date." },
              title: { type: "string", description: "Event title. Required unless eventNodeId resolves a taxonomy label." },
              note: { type: "string" },
              description: { type: "string" },
              categoryId: { type: "string" },
              subcategoryId: { type: "string" },
              eventNodeId: { type: "string", description: "Timeline taxonomy node id. Use this or provide a title." },
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: true,
          },
        },
        locale: { type: "string", description: "Optional timeline locale." },
        mode: { type: "string", description: "Optional write mode, usually merge." },
        finalize: { type: "boolean", description: "Whether to finalize the day after writing." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      validateTimelineWriteArgs(args);
      const result = await services.timeline.write(args);
      return {
        text: "Timeline write completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_build",
    description: "Build the timeline site through timeline-for-agent.",
    shortHint: "Build the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.build(args);
      return {
        text: "Timeline build completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_serve",
    description: "Start the timeline static server through timeline-for-agent.",
    shortHint: "Serve the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.serve(args);
      return {
        text: result.url ? `Timeline serve started at ${result.url}` : "Timeline serve completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_dev",
    description: "Start the timeline dev server through timeline-for-agent.",
    shortHint: "Start the timeline dev server, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.dev(args);
      return {
        text: result.url ? `Timeline dev started at ${result.url}` : "Timeline dev completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_screenshot",
    description: "Capture a timeline screenshot and send it back to the current WeChat chat.",
    shortHint: "Capture a timeline screenshot with structured selection fields.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional explicit WeChat user id." },
        outputFile: { type: "string", description: "Optional absolute output path for the PNG file." },
        selector: { type: "string", description: "main, timeline, analytics, events, or a custom CSS selector." },
        range: { type: "string", description: "Optional range: day, week, or month." },
        date: { type: "string", description: "Optional day selector YYYY-MM-DD." },
        week: { type: "string", description: "Optional week key." },
        month: { type: "string", description: "Optional month selector YYYY-MM." },
        category: { type: "string", description: "Optional category label or id." },
        subcategory: { type: "string", description: "Optional subcategory label or id." },
        width: { type: "integer", description: "Optional viewport width in pixels." },
        height: { type: "integer", description: "Optional viewport height in pixels." },
        sidePadding: { type: "integer", description: "Optional screenshot padding in pixels." },
        locale: { type: "string", description: "Optional timeline locale." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const captured = await services.timeline.captureScreenshot(args);
      const delivery = await services.channelFile.sendToCurrentChat({
        userId: args.userId,
        filePath: captured.outputFile,
      }, context);
      return {
        text: `Timeline screenshot sent: ${captured.outputFile}`,
        data: {
          ...captured,
          delivery,
        },
      };
    },
  },
  // ── Todo Tools ──────────────────────────────────────────────────
  {
    name: "cyberboss_todo_list",
    description: "List todo items in a COMPACT view (id/title/status/due/currentStep/nextCheckAt only). By default only pending/active items. Use todo_get for full details of one item.",
    shortHint: "List uncompleted todo items (compact).",
    topics: ["todo"],
    inputSchema: {
      type: "object",
      properties: {
        includeCompleted: { type: "boolean", description: "Set true to include completed items." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.todo.list({ includeCompleted: !!args.includeCompleted });
      const todos = (result.todos || []).map(compactTodoView);
      return {
        text: `Todo items: ${todos.length} active (${result.total} total).`,
        data: { todos, total: result.total },
      };
    },
  },
  {
    name: "cyberboss_todo_get",
    description: "Get ONE todo by id with its full record (including note, completionCriteria, version, snooze state). Use when you need details beyond the compact list.",
    shortHint: "Get full detail of one todo by id.",
    topics: ["todo"],
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Todo id such as todo_001." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const todo = services.todo.getById(args.id);
      if (!todo) {
        return { text: `Todo not found: ${args.id}`, data: { found: false } };
      }
      return {
        text: `Todo ${todo.id}: ${todo.title}`,
        data: { found: true, todo },
      };
    },
  },
  {
    name: "cyberboss_todo_create",
    description: "Create a new todo item. Create ONE todo per call — do not combine multiple tasks into one item. Use for clear, specific tasks the user mentions.",
    shortHint: "Create a todo item from user's request.",
    topics: ["todo"],
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "Todo title. One task only — do not list multiple items here." },
        due: { type: "string", description: "Optional due date in YYYY-MM-DD format." },
        repeat: { type: "string", description: "Optional repeat: daily or weekly." },
        note: { type: "string", description: "Optional notes." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.todo.create(args);
      if (result.error) {
        return { text: `Failed: ${result.error}`, data: result };
      }
      return {
        text: `Todo created: ${result.todo.id} - ${result.todo.title}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_todo_update",
    description: "Update an existing todo item's status or fields. Overdue items should prompt the user to reschedule or archive.",
    shortHint: "Update a todo's status (pending/active/completed) or fields.",
    topics: ["todo"],
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Todo id such as todo_001." },
        title: { type: "string", description: "New title." },
        due: { type: "string", description: "New due date in YYYY-MM-DD." },
        repeat: { type: "string", description: "New repeat: daily, weekly, or empty." },
        note: { type: "string", description: "New notes." },
        status: { type: "string", description: "New status: pending, active, or completed. Completed items are automatically removed." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.todo.update(args);
      if (result.error) {
        return { text: `Failed: ${result.error}`, data: result };
      }
      if (result.deleted) {
        // completed — cancel any todo_check reminders for it
        const cancelled = services.reminder?.cancelByTodoId ? services.reminder.cancelByTodoId(result.deleted.id) : 0;
        const msg = result.spawned
          ? `Todo done: ${result.deleted.title} (next instance created)`
          : `Todo done: ${result.deleted.title} (removed)`;
        return { text: msg, data: { ...result, remindersCancelled: cancelled } };
      }
      return {
        text: `Todo updated: ${result.todo.id} → ${result.todo.status}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_todo_supervise_start",
    description: "Put a todo into SUPERVISION mode: the system will send you a todo_check reminder every checkIntervalMin minutes to follow up on its progress. Use for tasks that need active chasing (habits, long tasks, things the user tends to procrastinate). Arms the first check immediately.",
    shortHint: "Start supervised follow-up checks on a todo.",
    topics: ["todo", "reminder"],
    inputSchema: {
      type: "object",
      required: ["id", "checkIntervalMin"],
      properties: {
        id: { type: "string", description: "Todo id such as todo_001." },
        currentStep: { type: "string", description: "The immediate next step the user should do." },
        checkIntervalMin: { type: "integer", description: "Check every N minutes (e.g. 60, 120)." },
        maxSnoozes: { type: "integer", description: "Max times the user may snooze before you nudge them (e.g. 3). 0 = unlimited." },
        completionCriteria: { type: "string", description: "What counts as done for this todo." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.todo.superviseStart(args);
      if (result.error) {
        return { text: `Failed: ${result.error}`, data: result };
      }
      const todo = result.todo;
      let reminder = null;
      try {
        reminder = await services.reminder.create({
          kind: "todo_check",
          text: `检查进度：${todo.title}${todo.currentStep ? `（下一步：${todo.currentStep}）` : ""}`,
          delayMinutes: todo.checkIntervalMin,
          sourceTodoId: todo.id,
          todoVersion: todo.version,
          dedupeKey: `todo:${todo.id}`,
        }, context);
      } catch (error) {
        return {
          text: `Todo supervised but reminder arming failed: ${error.message}`,
          data: { todo, reminderError: error.message },
        };
      }
      return {
        text: `Todo ${todo.id} is now supervised. Next check in ${todo.checkIntervalMin} min.`,
        data: { todo, reminder: reminder ? { id: reminder.id, dueAtMs: reminder.dueAtMs } : null },
      };
    },
  },
  {
    name: "cyberboss_todo_progress",
    description: "Report progress on a supervised todo. started: user began (note = current step). blocked: user is stuck (note = obstacle). snoozed: defer to next check (re-arms the reminder; after maxSnoozes you must nudge the user). completed: mark done (cancels its reminders).",
    shortHint: "Report progress: started / blocked / snoozed / completed.",
    topics: ["todo", "reminder"],
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: "string", description: "Todo id such as todo_001." },
        status: { type: "string", description: "started, blocked, snoozed, or completed." },
        note: { type: "string", description: "For started: the current step. For blocked: the obstacle. Optional otherwise." },
        nextCheckInMin: { type: "integer", description: "For snoozed: override the next check interval in minutes (default: the todo's checkIntervalMin)." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.todo.progress(args);
      if (result.error) {
        return { text: `Failed: ${result.error}`, data: result };
      }
      if (result.action === "completed") {
        const cancelled = services.reminder?.cancelByTodoId ? services.reminder.cancelByTodoId(String(args.id || "").trim()) : 0;
        const msg = result.spawned
          ? `Todo done: ${result.deleted?.title} (next instance created)`
          : `Todo done: ${result.deleted?.title} (removed)`;
        return { text: msg, data: { action: "completed", remindersCancelled: cancelled } };
      }
      if (result.action === "snoozed") {
        // cancel old reminder, arm a new one with the updated version
        let reminder = null;
        try {
          const cancelled = services.reminder?.cancelByTodoId ? services.reminder.cancelByTodoId(result.todo.id) : 0;
          reminder = await services.reminder.create({
            kind: "todo_check",
            text: `检查进度：${result.todo.title}`,
            delayMinutes: result.todo.checkIntervalMin,
            sourceTodoId: result.todo.id,
            todoVersion: result.todo.version,
            dedupeKey: `todo:${result.todo.id}`,
          }, context);
          return {
            text: `Snoozed. Next check at ${result.nextCheckAt}.`,
            data: { action: "snoozed", nextCheckAt: result.nextCheckAt, snoozeCount: result.todo.snoozeCount, remindersCancelled: cancelled, reminder: reminder ? { id: reminder.id } : null },
          };
        } catch (error) {
          return { text: `Snoozed but reminder re-arm failed: ${error.message}`, data: { action: "snoozed", nextCheckAt: result.nextCheckAt, reminderError: error.message } };
        }
      }
      if (result.action === "snooze_exhausted") {
        return {
          text: `Snooze limit reached (${result.todo.snoozeCount}/${result.todo.maxSnoozes}). Nudge the user about this todo now.`,
          data: result,
        };
      }
      return {
        text: `Progress recorded: ${result.action}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_todo_habit_checkin",
    description: "Record that a repeat=daily habit was completed today without completing or replacing the todo. The check-in is idempotent per Beijing calendar date and updates the habit streak and completion count.",
    shortHint: "Mark a daily habit complete for today.",
    topics: ["todo"],
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Daily habit todo id such as todo_001." },
        date: { type: "string", description: "Optional Beijing date YYYY-MM-DD; defaults to today." },
        note: { type: "string", description: "Optional short completion note." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.todo.habitCheckin(args);
      if (result.error) {
        return { text: `Failed: ${result.error}`, data: result };
      }
      return {
        text: result.duplicate
          ? `Habit already checked in for ${result.date}: ${result.todo.title}`
          : `Habit checked in for ${result.date}: ${result.todo.title}`,
        data: {
          id: result.todo.id,
          date: result.date,
          duplicate: result.duplicate,
          streak: result.todo.habitStreak,
          completionCount: result.todo.habitCompletionCount,
          nextDue: result.todo.due,
        },
      };
    },
  },
  {
    name: "cyberboss_todo_get_active",
    description: "Compact list of supervised or unfinished todos that need attention (id/title/currentStep/nextCheckAt/status). Use to decide what to follow up on.",
    shortHint: "List todos under supervision needing attention.",
    topics: ["todo"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = services.todo.list({ includeCompleted: false });
      const items = (result.todos || []).map(compactTodoView);
      const supervised = items.filter((t) => t.supervisionMode === "supervised");
      return {
        text: `${supervised.length} supervised, ${items.length} active total.`,
        data: { supervised, active: items },
      };
    },
  },
  // ── Memory Tools ─────────────────────────────────────────────────
  {
    name: "cyberboss_memory_read",
    description: "Read a memory space: memory = long-term memory (MEMORY.md, shared across runtimes); career = career material archive (CAREER.md). Use memory when you need persistent facts about the user; use career ONLY when writing a resume, preparing for interviews, or discussing her career — never auto-load it otherwise.",
    shortHint: "Read the long-term memory or career archive.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", enum: ["memory", "career"], description: "memory (default) or career." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.memory.read({ space: args.space });
      if (!result.ok) {
        return { text: `Memory read failed: ${result.error}`, data: result };
      }
      return {
        text: result.exists
          ? `Memory loaded (${result.chars} chars). Do NOT echo the full content back; use it silently.`
          : "Memory is empty.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_memory_append",
    description: "Append to a memory space. memory (default): only durable knowledge that still matters in 3+ months (relationship structure, stable preferences, long-term behavior patterns); MUST provide durabilityReason (validated, never stored); entry max 400 chars, file max 3000. career: career material archive (resume facts, project details, interview prep) — no durabilityReason needed, entry max 1000 chars, file max 10000; use sections like 项目经历 / 技能 / 面试准备 to organize.",
    shortHint: "Append to long-term memory or career archive.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        space: { type: "string", enum: ["memory", "career"], description: "memory (default) or career." },
        text: { type: "string", description: "The fact or note. Plain language." },
        durabilityReason: { type: "string", description: "Required for space=memory: why this still matters in 3 months (>= 10 chars). Ignored for career." },
        section: { type: "string", description: "Optional section heading. Appends under that section, creating it if missing." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.memory.append(args);
      if (!result.ok) {
        const hint = result.overLimit
          ? " Space is full — read it, then edit/delete outdated entries with the edit tool."
          : "";
        return { text: `Memory append rejected: ${result.error}${hint}`, data: result };
      }
      return {
        text: "Memory appended. Do NOT echo what was written.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_memory_edit",
    description: "Edit a memory space: replace or delete a specific piece of text. Use when an entry is outdated, wrong, or superseded. Replaces/deletes the FIRST occurrence of search.",
    shortHint: "Replace or delete a piece of memory.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["search"],
      properties: {
        space: { type: "string", enum: ["memory", "career"], description: "memory (default) or career." },
        search: { type: "string", description: "Text to find (first occurrence is edited)." },
        new_text: { type: "string", description: "Replacement text (required for replace mode)." },
        mode: { type: "string", description: "replace (default) or delete." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.memory.edit(args);
      if (!result.ok) {
        return { text: `Memory edit failed: ${result.error}`, data: result };
      }
      return {
        text: result.modified ? "Memory entry updated." : "Memory entry unchanged.",
        data: result,
      };
    },
  },
];

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildToolDescription(tool) {
  // Keep it terse: the MCP layer already exposes inputSchema separately, so
  // re-printing the signature here just burns tokens every turn.
  return normalizeText(tool?.description);
}

function summarizeSchema(schema, { depth = 0 } = {}) {
  if (!schema || typeof schema !== "object") {
    return "";
  }
  const schemaType = normalizeText(schema.type).toLowerCase();
  if (schemaType === "object") {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(properties);
    if (!entries.length) {
      return "{}";
    }
    const parts = entries.map(([key, value]) => {
      const suffix = required.has(key) ? "" : "?";
      return `${key}${suffix}: ${summarizeSchema(value, { depth: depth + 1 }) || "any"}`;
    });
    return `{ ${parts.join(", ")} }`;
  }
  if (schemaType === "array") {
    const itemSummary = summarizeSchema(schema.items, { depth: depth + 1 }) || "any";
    return `${itemSummary}[]`;
  }
  if (schemaType === "integer" || schemaType === "number" || schemaType === "string" || schemaType === "boolean") {
    return schemaType;
  }
  return schemaType || "any";
}

function compactTodoView(todo) {
  if (!todo || typeof todo !== "object") {
    return {};
  }
  return {
    id: todo.id,
    title: todo.title,
    status: todo.status,
    due: todo.due || "",
    repeat: todo.repeat || "",
    currentStep: todo.currentStep || "",
    nextCheckAt: todo.nextCheckAt || "",
    supervisionMode: todo.supervisionMode || "none",
    lastHabitCompletedDate: todo.lastHabitCompletedDate || "",
    habitStreak: Number(todo.habitStreak) || 0,
    habitCompletionCount: Number(todo.habitCompletionCount) || 0,
  };
}

function validateTimelineWriteArgs(args) {
  const events = Array.isArray(args?.events) ? args.events : [];
  events.forEach((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return;
    }
    const hasTitle = normalizeText(event.title).length > 0;
    const hasEventNodeId = normalizeText(event.eventNodeId).length > 0;
    if (!hasTitle && !hasEventNodeId) {
      throw new Error(`cyberboss_timeline_write input.events[${index}].title or input.events[${index}].eventNodeId is required.`);
    }
  });
}

function validateSchema(schema, value, toolName, path) {
  if (!schema || typeof schema !== "object") {
    return;
  }
  const schemaType = schema.type;
  if (schemaType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an object.`);
    }
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        throw new Error(`${toolName} ${path}.${key} is required.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new Error(`${toolName} ${path}.${key} is not allowed.`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        validateSchema(propertySchema, value[key], toolName, `${path}.${key}`);
      }
    }
    return;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an array.`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(schema.items, item, toolName, `${path}[${index}]`));
    }
    return;
  }
  if (schemaType === "string" && typeof value !== "string") {
    throw new Error(`${toolName} ${path} must be a string.`);
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    throw new Error(`${toolName} ${path} must be a boolean.`);
  }
  if (schemaType === "integer" && !Number.isInteger(value)) {
    throw new Error(`${toolName} ${path} must be an integer.`);
  }
  if (schemaType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${toolName} ${path} must be a number.`);
  }
}

module.exports = {
  ProjectToolHost,
  listProjectToolNames,
};
