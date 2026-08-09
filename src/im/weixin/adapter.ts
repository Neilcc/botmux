/**
 * 微信 Clawbot 通道 —— ImAdapter 的一个实现。
 *
 * 设计要点（镜像 src/im/telegram/adapter.ts 骨架）：
 * - 微信私聊即会话：每个微信用户（`<userId>@im.wechat`）是一个 threadId
 *   `wx:<accountId>:<userId>`。
 * - 微信没有「卡片」，ImCardBuilder 用结构化文本渲染（rich/text 都走纯文本），
 *   sendCard/updateCard 映射到 sendText。
 * - context_token 按用户颁发，出站必须原样带回 —— 由 WeixinClient 管理。
 * - 长轮询拉取，空闲 35s 超时，健壮容错。
 */

import type {
  ImAdapter,
  ImAttachment,
  ImCard,
  ImCardAction,
  ImCardBuilder,
  ImEventHandler,
  ImMessage,
  ImUser,
} from '../types.js';
import type { StreamStatus } from '../../types.js';
import {
  WeixinClient,
  type WeixinInboundMessage,
  type WeixinMessageItem,
} from './client.js';

export interface WeixinAdapterOptions {
  /** openclaw 账户 id（也是 botmux weixin bot 的 weixinAccountId）。 */
  accountId: string;
  /** 微信 bot token（可从 openclaw 账户文件读取，见 loadWeixinAccountCredentials）。 */
  token: string;
  /** 覆盖 baseUrl（测试用）。 */
  baseUrl?: string;
  /** 轮询间隔（毫秒）。默认 1000。 */
  pollIntervalMs?: number;
  /** long-polling 超时（毫秒）。默认 35000。 */
  pollTimeoutMs?: number;
  /** context_token 持久化文件路径（可选）。 */
  contextTokenFile?: string;
  /** 允许的微信用户 id（`<id>@im.wechat`，形如 `o9cq...@im.wechat`）。空 = 放行。 */
  allowedUserIds?: string[];
}

export class WeixinAdapter implements ImAdapter {
  readonly cards: ImCardBuilder = new WeixinCardBuilder();

  private readonly client: WeixinClient;
  private readonly accountId: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly contextTokenFile?: string;
  private readonly allowedUserIds: Set<string>;
  private handler?: ImEventHandler;
  private running = false;
  private pollLoop?: Promise<void>;

  constructor(opts: WeixinAdapterOptions) {
    this.accountId = opts.accountId;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 35_000;
    this.contextTokenFile = opts.contextTokenFile;
    this.allowedUserIds = new Set(opts.allowedUserIds ?? []);
    this.client = new WeixinClient({
      accountId: opts.accountId,
      token: opts.token,
      baseUrl: opts.baseUrl,
      contextTokenFile: opts.contextTokenFile,
    });
  }

  async start(handler: ImEventHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
    this.pollLoop = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollLoop) await this.pollLoop.catch(() => undefined);
    this.pollLoop = undefined;
  }

  getBotUserId(): string | undefined {
    return this.accountId;
  }

  // ── 发送 ──────────────────────────────────────────────────────────────

  async sendMessage(threadId: string, content: string, _format: 'text' | 'rich'): Promise<string> {
    const userId = this.parseThreadId(threadId);
    return this.client.sendText(userId, content);
  }

  async replyMessage(messageId: string, content: string, _format: 'text' | 'rich'): Promise<string> {
    // messageId 形如 `wx:<accountId>:<userId>`，回复即给该用户发新消息。
    return this.sendMessage(messageId, content, 'text');
  }

  async updateMessage(_messageId: string, _content: string): Promise<void> {
    // 微信无消息编辑能力，忽略（保留 API 兼容）。
  }

  async sendCard(threadId: string, card: ImCard): Promise<string> {
    const text = (card.payload as { text?: string })?.text ?? String(card.payload);
    return this.sendMessage(threadId, text, 'text');
  }

  async updateCard(_messageId: string, _card: ImCard): Promise<void> {
    // 微信无卡片编辑，忽略。
  }

  // ── 用户 / 消息 ───────────────────────────────────────────────────────

  async resolveUsers(identifiers: string[]): Promise<ImUser[]> {
    return identifiers.map((id) => ({ id, identifier: id }));
  }

  async sendDirectMessage(userId: string, content: string): Promise<void> {
    await this.client.sendText(userId, content);
  }

  async getThreadMessages(_threadId: string, _limit: number): Promise<ImMessage[]> {
    // 微信 getUpdates 不提供按会话拉历史聊天的稳定接口，返回空。
    return [];
  }

  async downloadAttachment(_messageId: string, _resourceKey: string): Promise<string> {
    throw new Error('weixin downloadAttachment: 媒体留待后续 ImAttachment 映射');
  }

  async addReaction(_messageId: string, _emojiType: string): Promise<string> {
    throw new Error('weixin addReaction: 微信无公开 reaction API');
  }

  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {
    throw new Error('weixin removeReaction: 微信无公开 reaction API');
  }

  // ── 轮询 ──────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const msgs = await this.client.getUpdates({ timeoutMs: this.pollTimeoutMs });
        for (const msg of msgs) {
          await this.dispatch(msg);
        }
      } catch (err) {
        // 网络抖动 / 凭证失效：静默退避重试，不崩 daemon。
        await new Promise((r) => setTimeout(r, this.pollIntervalMs * 5));
        continue;
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  private async dispatch(msg: WeixinInboundMessage): Promise<void> {
    if (!this.handler || !msg.from_user_id) return;
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(msg.from_user_id)) {
      return; // 非白名单用户，忽略
    }
    const text = this.client.consumeInbound(msg, this.contextTokenFile);
    if (text.trim()) {
      const im = this.toImMessage(msg, text);
      await this.handler.onNewTopic(im, im.threadId, 'p2p');
    }
  }

  // ── 映射 ──────────────────────────────────────────────────────────────

  threadKey(userId: string): string {
    return `wx:${this.accountId}:${userId}`;
  }

  private parseThreadId(threadId: string): string {
    // `wx:<accountId>:<userId>` -> userId
    return threadId.split(':').slice(2).join(':');
  }

  private toImMessage(msg: WeixinInboundMessage, text: string): ImMessage {
    const senderId = msg.from_user_id ?? '';
    const attachments: ImAttachment[] = [];
    for (const item of msg.item_list ?? []) {
      const a = this.itemToAttachment(item);
      if (a) attachments.push(a);
    }
    return {
      id: msg.client_id ?? this.threadKey(senderId),
      threadId: this.threadKey(senderId),
      senderId,
      senderType: 'user',
      content: text,
      msgType: attachments.length ? 'image' : 'text',
      attachments: attachments.length ? attachments : undefined,
      createTime: msg.create_time_ms ? new Date(msg.create_time_ms).toISOString() : new Date(0).toISOString(),
    };
  }

  private itemToAttachment(item: WeixinMessageItem): ImAttachment | undefined {
    if (item.type === 2) return { type: 'image', path: String(item.image_item ?? ''), name: 'image' };
    if (item.type === 4) return { type: 'file', path: String(item.file_item ?? ''), name: 'file' };
    return undefined;
  }
}

/** 微信无卡片：用结构化文本渲染卡片标题/正文/状态。 */
class WeixinCardBuilder implements ImCardBuilder {
  buildSessionCard(opts: { sessionId: string; rootMessageId: string; terminalUrl: string; title: string }): ImCard {
    return {
      payload: {
        text: [
          `**${opts.title}**`,
          `会话: ${opts.sessionId}`,
          `终端: ${opts.terminalUrl}`,
        ].join('\n'),
      },
    };
  }

  buildStreamingCard(opts: {
    sessionId: string;
    rootMessageId: string;
    terminalUrl: string;
    title: string;
    content: string;
    status: StreamStatus;
  }): ImCard {
    const badge =
      opts.status === 'starting' ? '⏳'
      : opts.status === 'working' ? '▶️'
      : opts.status === 'analyzing' ? '🔍'
      : opts.status === 'limited' ? '⚠️'
      : opts.status === 'stalled' ? '⛔'
      : '⏸';
    return {
      payload: {
        text: `${badge} **${opts.title}**\n\n${(opts.content ?? '').slice(0, 4000)}`,
      },
    };
  }

  buildRepoSelectCard(opts: {
    projects: Array<{ name: string; path: string; description: string }>;
    currentCwd: string;
    rootMessageId: string;
  }): ImCard {
    const lines = opts.projects.map((p, i) => `${i + 1}. **${p.name}** — \`${p.path}\``);
    return {
      payload: {
        text: `选择工作目录（当前: \`${opts.currentCwd}\`）:\n${lines.join('\n')}`,
      },
    };
  }
}