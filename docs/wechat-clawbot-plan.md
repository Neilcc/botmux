# 微信 Clawbot 接入 botmux 方案文档

> 状态：**已联通（Track 1 可用）+ Track 2 基础已落地（v0.2）**
> 日期：2026-08-09（更新 2026-08-10）
> 目标：让「微信 Clawbot」的对话能控制本服务器（走 botmux → Claude Code / Codex 会话）
> 参考：[微信 clawbot 实测文章](https://mp.weixin.qq.com/s/1_8gWO-lo-BqsuKbGCwxfg)

---

## 0. 现状盘点（2026-08-10）

### 已联通（Track 1，立即可用）
- openclaw 网关默认模型已切 `claude-cli/sonnet`，微信 clawbot 消息 → 本机 Claude Code CLI 回复。
- root 下需 `IS_SANDBOX=1` 解锁 Claude Code root 逃生舱（**用户已授权**，写入 `~/.config/systemd/user/openclaw-gateway.service`）。
- 微信通道 `ad84cc0d97e4-im-bot` 健康，`openclaw channels status --probe` 确认。

### Track 2（botmux 微信通道）已落地
- `src/im/weixin/{client,adapter,index}.ts`：微信长轮询传输 + ImAdapter，编译通过、`pnpm build` 绿。
- `BotConfig.channel?: 'lark'|'weixin'` 配置面已加（缺省 lark，飞书主路径不动）。
- Telegram 适配器编译已修复（同款 StreamStatus 导入/类型/徽标问题）。
- 提交 `c5ce8b6`。
- **剩余**：daemon 会话接线（channel-aware `getBotClient` 出站 + 微信入站灌 `botEventHandlers`），是后续增量。

## 1. 现状盘点（2026-08-09，服务器刚重启后）

### 已修复 / 已确认
| 项 | 状态 |
|---|---|
| botmux  服务 | ✅ 已用 `systemctl --user restart botmux` 重启；用户级 `botmux.service` 开机自启 |
| 飞书 claude 机器人（app_id 已脱敏） | ✅ 健康，`all critical scopes granted` |
| 飞书 codex 机器人（app_id 已脱敏） | ➖ **已从 bots.json 移除**（报 `app unauthorized 10014`，凭证问题；且计划让它转接微信） |
| claude CLI | ✅ 2.1.226，已 `ln -s` 到 `/usr/local/bin/claude`，重启不再消失 |
| codex CLI | ✅ 0.147.0，`/usr/local/bin/codex` |
| tg-bridge（Telegram 网关） | ✅ 在跑，token 有效（bot `Zccfinbot`），能调 claude `-p` |
| botmux Telegram 适配器 | ⏳ 代码在 `botmux-fork/src/im/telegram/`，**未接线进 daemon** |

### 备份
- `/root/.botmux/bots.json.bak.1786290378`
- `/root/.botmux/ecosystem.config.json.bak.1786290378`

---

## 1. 名词澄清

- **Clawbot**：微信官方近期上线的能力，把**本地 openclaw** 通过官方接口接入微信（安卓/iOS 已支持，微信需 **8.0.70**，个别机型除外）。
- **openclaw**：一个「多通道 AI 网关」（`npm i -g openclaw`，2026.7.x），支持 WhatsApp/Telegram/WeChat/Feishu/QQ/… 等通道，把各通道消息路由到本地 Agent。
- **openclaw-weixin 插件**：负责微信通道的插件（`@tencent-weixin/openclaw-weixin`，按 dist-tag 分发，靠 `openclaw plugins install` 拉取）。
- **botmux**：本项目，飞书话题群 ↔ AI 编程 CLI 桥接，负责**会话管理 / PTY / CLI 适配 / 卡片**。

> 关键机制：微信 clawbot 的接入不是「微信 Bot API」，而是 **openclaw 的微信通道**。所以微信必然经过 openclaw。我们要做的，是让 openclaw 收到的微信消息路由到 botmux。

---

## 2. 接入现状研究（openclaw 怎么装、怎么接微信）

官方接入命令（mac 直接可用；**服务器/Windows 需先装好 Claude Code 或 codex 来辅助**）：

```bash
npm install -g openclaw          # 1. 装 openclaw 网关
npx -y @tencent-weixin/openclaw-weixin-cli install   # 2. 装微信插件 + 引导
```

`install` 自动完成：
1. 检测 `openclaw --version`，按兼容矩阵选插件 dist-tag
2. `openclaw plugins install "@tencent-weixin/openclaw-weixin@<tag>"`
3. `openclaw channels login --channel openclaw-weixin` → **弹出二维码，微信扫码绑定**
4. `openclaw gateway restart`

openclaw 的 agent runtime 层（`docs/concepts/agent-runtimes.md`）：
- 内嵌 harness：`openclaw`（默认）、`codex`、`copilot`（插件）
- **CLI 后端**：模型 ref 配 `agentRuntime.id: "claude-cli"` → 走本机 Claude CLI 执行
- 外部 harness（Claude Code / Gemini / OpenCode / Cursor）走 **ACP/acpx**

---

## 3. botmux 通道接线点（架构调研结论）

> 调研基于 `botmux-fork` 源码。**重要**：`ImAdapter` 接口是「为未来预留」的，**Lark 主路径根本没走它**。

### 3.1 真实结构（不是 ImAdapter）
- **出站**：`src/im/lark/client.ts` 的自由函数（绕开 ImAdapter），第一个参数都是 `larkAppId` → `getBotClient(larkAppId)`（`bot-registry.ts:1830`）。
- **入站**：`src/daemon.ts:20682` 组装的 `botEventHandlers`（类型 `EventHandlers`，`event-dispatcher.ts:2022`），由 `startLarkEventDispatcher`（`event-dispatcher.ts:2634`，内部 `Lark.WSClient` 长连接）喂 WS 事件。
- **接线分支**：`daemon.ts:20715` 的 `if (!cfg.apiOnly) startLarkEventDispatcher(...)`。
- **每 bot 一个 daemon 进程**（PM2 按 `BOTMUX_BOT_INDEX` 取 bots.json 对应项）。

### 3.2 加通道最重要的阻抗点
`EventHandlers` 的签名是 `(data: any, ctx: RoutingContext)`，而预留的 `ImAdapter`/`ImEventHandler` 是 `(msg: ImMessage)` / `(action: ImCardAction)`——两者**不一致**。所以无论 Telegram 还是微信，都要写一层**适配**，把新通道的 `ImMessage` 转成 Lark 的 `data/ctx`，才能灌进 `botEventHandlers`。

### 3.3 三种可选改造路径
1. **硬接 `botEventHandlers`**（推荐，改动小）：在 `daemon.ts:20715` 按 `cfg.channel` 分派，新通道适配器把消息转 `data/ctx` 后直接喂既有 handler。复用全部会话/worker/CLI 逻辑。
2. **让新通道完整实现 `ImAdapter`**（Telegram 适配器现状）：需把 `botEventHandlers` 也适配成 `ImEventHandler`，改动大、且 Lark 出站是自由函数，两套体系并存，维护成本高。
3. **完全重构为多通道抽象**：动 `Lark` 主路径，风险最大，不推荐现在做。

### 3.4 Telegram 适配器现状（`src/im/telegram/`）
- `adapter.ts`（289 行）：`TelegramAdapter implements ImAdapter` + `TelegramCardBuilder implements ImCardBuilder`，**两接口方法基本实现完整**。
- `client.ts`：基于 fetch 的 `TelegramClient`，长轮询（空闲 30s 超时）。
- `index.ts`：re-export。
- **未接线**：全仓库除 `telegram/` 自身与 test 外零 import。是现成的**轮询型通道模板**。

---

## 4. 推荐架构

```
手机微信（clawbot，微信 8.0.70）
   │  官方接口
   ▼
openclaw 网关（微信通道插件 openclaw-weixin）
   │  微信扫码绑定后，微信消息进入 openclaw
   ▼
[ 桥接层：openclaw → botmux ]
   │  把 openclaw 收到的微信消息转成 botmux 的 BotMessage
   ▼
botmux（botEventHandlers → 会话管理 → worker → CLI 适配器）
   │  按该 bot 的 cliId 启动 Claude Code / Codex
   ▼
受控的服务器 / 代码执行
```

两条物理落地方案：

### 方案 A（推荐）：botmux 内建「openclaw 微信转发」通道
- botmux 新增 `channel: 'openclaw-weixin'` 的 bot。
- botmux 以**长轮询/HTTP**方式从 openclaw 拉微信消息（或 openclaw 推 webhook 给 botmux）。
- 复用 Telegram 适配器的**轮询骨架**，把 `TelegramClient` 换成「openclaw 微信拉取/推送客户端」。
- **优点**：微信会话直接进 botmux 既有会话/终端/CLI 机制；与 Telegram 一条代码路径。
- **待确认**：openclaw 是否暴露「外部拉取微信消息」的接口（大概率需看 openclaw 的 channel/plugin SDK，或为 openclaw 写一个「转发到 botmux」的自定义 agent 后端）。

### 方案 B：openclaw 作前端，agent 后端指向 botmux
- openclaw 跑微信通道；把 openclaw 的 agent 配置成「调用 botmux」。
- openclaw 有 CLI 后端 / ACP 外部 harness 机制，可写一个最小 harness 把对话转发给 botmux。
- **优点**：openclaw 自己管微信心跳/重连/多账号。
- **缺点**：多一层，且 openclaw 的 harness 开发曲线不低。

> 本方案文档当前推荐 **方案 A**，因为它最贴合 botmux 现有「bot + 通道 + CLI」模型，且与正在做的 Telegram 适配器共用骨架。方案 B 作为备选。

---

## 5. 实施步骤（供后续执行）

### Phase 0 — 环境准备（本机）
- [ ] `npm install -g openclaw`（约 88MB）
- [ ] 确认 `openclaw --version`
- [ ] 确认微信手机端 **≥ 8.0.70**

### Phase 1 — 微信绑定（**需用户手机扫码，手动**）
- [ ] `npx -y @tencent-weixin/openclaw-weixin-cli install`
- [ ] 终端弹二维码 → 用户用微信扫码绑定
- [ ] `openclaw channels login --channel openclaw-weixin` 确认
- [ ] `openclaw gateway restart`
- [ ] 验证：微信给 clawbot 发消息，openclaw 能收到

### Phase 2 — 桥接层
- [ ] 调研 openclaw 的 channel/plugin SDK，确认「外部读取微信消息」或「转发给任意后端」的接口
- [ ] 实现 openclaw → botmux 的转发（HTTP/WS/webhook）
- [ ] 或实现 botmux 侧的「openclaw 微信拉取客户端」

### Phase 3 — botmux 微信通道
- [ ] `BotConfig` 加字段 `channel?: 'lark'|'telegram'|'openclaw-weixin'`
- [ ] `daemon.ts:20715` 按 `cfg.channel` 分派启动对应通道
- [ ] 写适配层：新通道 `ImMessage` → `botEventHandlers` 的 `data/ctx`
- [ ] bots.json 加一个 `channel: 'openclaw-weixin'`、`cliId: 'codex'`（用户要用 codex 接微信）的 bot
- [ ] 复用 Telegram 的 `TelegramCardBuilder` 思路做「无卡片文本渲染」

### Phase 4 — 验证
- [ ] 微信发消息 → 收到 codex/claude 会话回复
- [ ] 断网/重连/重启，会话可恢复
- [ ] 与飞书、Telegram 并存不互相影响

---

## 6. 备选/待确认项
- [ ] **openclaw 是否暴露可编程的微信消息接口**（最关键依赖，需先确认才能定方案 A 的具体实现）
- [ ] 微信 clawbot 是否只支持**个人微信**（企业微信/群聊支持度待验证）
- [ ] 语音/图片/文件：微信 clawbot 支持读图片、收语音、发电脑文件，需在适配器里映射 `ImAttachment`
- [ ] 是否要一个独立系统服务（`openclaw.service`）托管 openclaw，开机自启（仿照 `tg-bridge.service`）

---

## 7. 风险
- openclaw 是第三方大项目（88MB），依赖面广，升级可能有破坏性变更。
- 微信官方 clawbot 是最新能力，接口/protocol 可能快速变化。
- 微信风控：个人微信自动化存在封号风险，绑定用主号需谨慎。
- botmux 加通道的核心阻抗在 `EventHandlers` 签名适配，需仔细测试不破坏飞书主路径。