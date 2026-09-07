# Cyberboss：可靠的本地微信 Agent 桥接

[English](./README.md)

Cyberboss 将本机运行的 Codex 或 Claude Code 接入微信，并提供提醒、任务监督、日记、时间线、文件发送和后台 check-in。所有用户数据默认保留在本地。

本仓库是基于 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss) 的、经过隐私脱敏的独立衍生版本，保留上游署名与许可证。它使用独立的公开历史，并非 GitHub 网络意义上的 Fork；详见 [NOTICE](./NOTICE)。其重点不是重新包装原有功能，而是解决持续真实使用后出现的投递、状态与恢复问题。

## 相对上游的工程改进

### 微信消息可靠投递

- 为每次投递和每个分片生成稳定标识，实现幂等发送。
- 记录投递回执；仅对可重试失败执行有限重试和指数退避。
- 队列去重与单消费者 drain，避免重启或并发 flush 导致重复消息。
- 在保持微信式分片体验的前提下合并连续纯文本回复，避免重复投递。

### 后台事件状态流

`fixed_time`、`todo_check`、`checkin` 和 diagnostic 事件在完成投递前始终保留账号、用户、工作区和线程路由上下文。提醒 `ack` 与最终微信正文解耦，避免确认提醒后把本应发送的消息吞掉。

```text
scheduled → fired → outbound delivery → acknowledged
                   ↘ retry / cancelled / expired
```

队列会在启动时 reconcile：宽限期内恢复中断提醒，超出宽限期的旧数据自动过期，不再永久停留在 scheduled。

### 循环提醒与任务监督

- 每日/每周提醒在确认后自动安排下一次。
- Todo 监督支持当前步骤、完成条件、延期上限和版本号，旧提醒不会覆盖新计划。
- `todo_progress` 自动续期下一轮监督。
- 每日习惯通过独立打卡记录当天完成，不会误把整个习惯 Todo 标记结束。

### 线程与运行时韧性

- 账号、用户和工作区动态绑定，不依赖写死的回复目标。
- 处理上下文压缩事件，并过滤 Codex commentary，避免中间过程污染微信正文。
- 运行时暂时不可用时，后台回复会保留原始投递目标并延迟重试。
- 支持线程压缩命令和工作区级模型选择。

### MCP 本地工具层

提供提醒、Todo 监督、日记、时间线、长期记忆、后台消息和当前会话文件发送等 MCP 工具。运行状态位于仓库外，因此源码可公开而不会泄露账号、会话或个人记录。

## 测试

新增的回归测试直接对应曾经出现过的工程问题：

- `ack` 后仍必须投递最终提醒正文；
- 所有后台事件必须保持原始回复目标；
- 循环/过期提醒的恢复与清理；
- 队列去重、单消费者 drain 与退避；
- 每日习惯打卡和监督自动续期；
- Codex commentary 过滤与上下文压缩事件。

```bash
npm install
npm run check
npm test
npm run audit:public
```

`npm test` 运行发布关键路径的隐私、路由、提醒、队列和 Todo 回归测试。`npm run test:all` 保留了更广的历史测试集；其中部分测试仍依赖 macOS 工具、可选本机依赖或 Unix 路径，需要进一步做跨平台整理。

## 隐私边界

仓库只包含源码、通用模板和虚构示例。以下内容必须保留在仓库外：账号 token、用户/线程 ID、会话状态、日记、提醒、待办、日志、真实人设及私人操作规则。

```text
source checkout/                         # 可提交
state directory/                         # 不提交
  accounts/ diary/ reminders/ logs/
  private/
    weixin-instructions.md               # 私有人设
    weixin-operations.md                 # 私人规则和例子
```

配置加载优先级：

1. 显式设置的 `CYBERBOSS_ENV_FILE`；
2. `~/.cyberboss/.env`；
3. 当前目录中仅用于兼容旧版本的 `.env`。

公开使用时，请将真实配置放在前两种位置。可从 [`.env.example`](./.env.example) 开始填写。

## 快速开始

需要 Node.js 22+、本机 Codex 或 Claude Code，以及可用的微信桥接账号。

```bash
git clone <your-fork-url>
cd cyberboss
npm install
# 将 .env.example 的内容复制到用户目录 ~/.cyberboss/.env 后填入本机配置
npm run login
npm start
```

Windows 下真实配置建议放在 `%USERPROFILE%\\.cyberboss\\.env`。第一次启动会在 state 目录创建通用的私有模板副本；只在 `state/private/` 中修改你的实际人设和操作规则。

## 公开仓库工作流

`npm run audit:public` 会检查待发布源码中的常见密钥、个人标识、本机路径、私有模板和生成物。可选 Git hook 安装命令：

```bash
npm run setup:public-sync -- --remote origin --branch main
```

该命令只安装本地审计与自动同步准备。启用后，源分支每次提交会先运行语法检查、发布关键回归测试和脱敏审计，再更新本地公开分支；它不会创建远端或执行推送。确认远端后，才可手动启用提交后自动推送：

```bash
git config cyberboss.publicSync true
```

## 署名与许可证

基于 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss)。除保留 [LICENSE](./LICENSE) 外，本仓库还在 [NOTICE](./NOTICE) 中记录上游来源、修改日期和主要改动类别。公开 `main` 分支是其所含发布版本的对应源码；如通过网络提供修改后的版本，应向远程用户清晰提供该部署版本的源码链接，以满足 AGPL 要求。
