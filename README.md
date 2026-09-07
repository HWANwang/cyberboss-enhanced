# Cyberboss: reliable local WeChat agent bridge

[中文说明](./README.zh-CN.md)

Cyberboss connects a locally running Codex or Claude Code runtime to WeChat. It keeps user data local and provides reminders, task supervision, diary and timeline tooling, file delivery, and background check-ins.

This repository is a privacy-safe engineering fork of [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss). It retains the upstream license and attribution while documenting the additional reliability work in this checkout.

## Why this fork exists

The upstream project establishes the local-first WeChat bridge, runtime adapters, timeline integration, reminders, diary support, and check-ins. This fork focuses on the failures that appear after an agent is used continuously: replies reaching the wrong account, duplicated messages after restarts, reminders that fire but never reach WeChat, stale task checks, and runtime-host changes that break local tools.

## Engineering highlights

### Reliable WeChat delivery

- Stable delivery identifiers and per-chunk idempotency keys for outbound text.
- Delivery-receipt handling, bounded retries, and exponential backoff for retryable failures.
- Queue-level de-duplication and a single-drain guard to prevent concurrent consumers from replaying the same event.
- Reply coalescing that preserves conversational WeChat segmentation while preventing duplicate plain-text sends.

### Background-event state machine

Background events (`fixed_time`, `todo_check`, `checkin`, and diagnostics) retain their account, user, workspace, and thread routing context until delivery finishes. Reminder acknowledgement is separated from the final outbound reply so an `ack` cannot consume the message intended for the user.

```text
scheduled → fired → outbound delivery → acknowledged
                   ↘ retry / cancelled / expired
```

The queue reconciles interrupted work at startup, recovers reminders within a grace window, and expires stale records rather than leaving them indefinitely scheduled.

### Recurring reminders and supervised tasks

- Daily and weekly reminder recurrence schedules the next occurrence after acknowledgement.
- Todo supervision tracks current step, completion criteria, snooze limits, and a version number to reject stale checks.
- `todo_progress` re-arms the next supervision check.
- Daily habit check-in records today's completion without incorrectly closing the underlying habit.

### Thread and runtime resilience

- Dynamic account/user/workspace binding instead of a hard-coded reply target.
- Context-compaction events and reply-phase filtering so runtime commentary does not leak into WeChat text.
- Deferred system replies survive a temporary runtime outage and retain their original target.
- Runtime command handling supports thread compaction and per-workspace model selection.

### Local MCP capability layer

The project exposes local tools for reminders, todo supervision, diary, timeline, long-term memory, background messages, and current-chat file delivery. Runtime state is stored outside the repository, allowing the same source tree to be safely shared without publishing a user's account or personal data.

## Regression tests

The test suite includes incident-driven cases for:

- acknowledgement followed by outbound reminder delivery;
- target retention across all background-event types;
- recurring and overdue reminder reconciliation;
- queue de-duplication, single-consumer draining, and backoff;
- daily habit check-in and supervision re-arming;
- Codex commentary filtering and context-compaction events.

Run checks locally:

```bash
npm install
npm run check
npm test
npm run audit:public
```

`npm test` runs the release-critical privacy, routing, reminder, queue, and todo regression suite. `npm run test:all` is retained for the broader legacy suite; several platform-specific tests still require portability work for Windows and optional local dependencies.

## Privacy model

The repository contains only source code, generic templates, and synthetic examples. Keep all mutable or identifying data outside the checkout:

```text
source checkout/                         # safe to commit
state directory/                         # never commit
  accounts/                              # account tokens and bindings
  diary/ reminders/ logs/ sessions/      # personal runtime data
  private/
    weixin-instructions.md               # private persona
    weixin-operations.md                 # private routines and rules
```

At startup, Cyberboss loads configuration in this order:

1. `CYBERBOSS_ENV_FILE`, when explicitly set;
2. `~/.cyberboss/.env`;
3. a legacy `.env` in the current directory.

For a publishable setup, use the first or second option. Copy [`.env.example`](./.env.example) as a starting point, but keep the real file outside the repository.

## Quick start

Requirements: Node.js 22+, a local Codex or Claude Code installation, and a supported WeChat bridge account.

```bash
git clone <your-fork-url>
cd cyberboss
npm install
mkdir -p ~/.cyberboss
cp .env.example ~/.cyberboss/.env
# edit ~/.cyberboss/.env with your local paths and account settings
npm run login
npm start
```

On Windows, place the real configuration at `%USERPROFILE%\\.cyberboss\\.env`. The first start creates public-safe default instruction files under the configured state directory; personalize only the copies in `state/private/`.

## Public-repository workflow

`npm run audit:public` scans tracked publication candidates for common secrets, personal identifiers, local paths, private templates, and generated artifacts. The repository also includes optional Git hooks:

```bash
npm run setup:public-sync -- --remote origin --branch main
```

This only installs a local pre-commit audit and prepares commit-triggered sync. On an enabled source-branch commit, the hook runs syntax checks, release-critical regression tests, and the publication audit before updating the local public branch. It never creates a remote or pushes by itself. Enable automatic post-commit pushes only after you have reviewed the target remote:

```bash
git config cyberboss.publicSync true
```

## Attribution and license

Based on [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss). The upstream project and this derivative are licensed under [AGPL-3.0-only](./LICENSE). Modifications in this repository are documented in the Git history and this README. When offering a modified version over a network, provide the corresponding source as required by the AGPL.
