/**
 * Telegram 通道 —— ImAdapter 的一个实现。
 *
 * 设计要点：
 * - 用 Telegram 原生「私聊即 topic」的映射：每个私聊 chat 是一个 threadId
 *   （`tg:<chatId>`）；群/超级群的 forum topic 用 `tg:<chatId>:<threadId>`。
 * - Telegram 没有「卡片」，因此 ImCardBuilder 用结构化文本渲染（rich/text 都走
 *   Markdown 文本），sendCard/updateCard 映射到 sendMessage/editMessageText。
 * - Reaction 用 Telegram 原生 message reaction 映射。
 * - 长轮询拉取，空闲时 30s 超时，健壮容错。
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
import { TelegramClient, type TgMessage, type TgUpdate } from './client.js';

const KNOWN_EMOJI: Record<string, string> = {
  thumbsup: '👍',
  thumbsdown: '👎',
  heart: '❤️',
  fire: '🔥',
  'party_popper': '🎉',
  rocket: '🚀',
  eyes: '👀',
  clap: '👏',
  check: '✅',
  cross: '❌',
  info: 'ℹ️',
  question: '❓',
  warning: '⚠️',
};

export interface TelegramAdapterOptions {
  /** Telegram bot token（形如 `123456:ABC...`）。 */
  token: string;
  /**
   * 允许的 user id（Telegram 数字 id）。空数组 = 放行所有人（仅测试/自用）。
   * 与 bots.json 的 allowedUsers 语义兼容：非空时只处理这些 id 发来的消息。
   */
  allowedUserIds?: number[];
  /** 轮询间隔（毫秒）。默认 1000。 */
  pollIntervalMs?: number;
  /** long-polling 超时（秒）。默认 30。 */
  pollTimeoutSec?: number;
  /** 覆盖 Telegram API 地址（测试用）。 */
  apiUrl?: string;
}

interface DevTalk {
  chatId: number;
  threadId?: number;
  message: TgMessage;
  updateId: number;
}

export class TelegramAdapter implements ImAdapter {
  readonly cards: ImCardBuilder = new TelegramCardBuilder();

  private readonly client: TelegramClient;
  private handler?: ImEventHandler;
  private readonly allowedUserIds: Set<number>;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutSec: number;
  private offset = 0;
  private running = false;
  private pollLoop?: Promise<void>;
  private me?: { id: number };
  private userCache = new Map<string, ImUser>();

  constructor(opts: TelegramAdapterOptions) {
    this.client = new TelegramClient(opts.token, { apiUrl: opts.apiUrl });
    this.allowedUserIds = new Set(opts.allowedUserIds ?? []);
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
  }

  async start(handler: ImEventHandler): Promise<void> {
    this.handler = handler;
    const me = await this.client.getMe();
    this.me = { id: me.id };
    this.running = true;
    this.pollLoop = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollLoop) await this.pollLoop.catch(() => undefined);
    this.pollLoop = undefined;
  }

  getBotUserId(): string | undefined {
    return this.me ? String(this.me.id) : undefined;
  }

  // ── 发送 ──────────────────────────────────────────────────────────────

  async sendMessage(threadId: string, content: string, format: 'text' | 'rich'): Promise<string> {
    const { chatId, threadId: tgThread } = this.parseThreadId(threadId);
    const msg = await this.client.sendMessage(chatId, content, {
      parseMode: format === 'rich' ? 'MarkdownV2' : 'Markdown',
      replyToMessageId: tgThread,
    });
    return String(msg.message_id);
  }

  async replyMessage(messageId: string, content: string, format: 'text' | 'rich'): Promise<string> {
    // replyMessage 需要知道 chatId——messageId 形如 `<chatId>:<msgId>`。
    const [chatId, msgId] = this.splitMessageKey(messageId);
    const msg = await this.client.sendMessage(Number(chatId), content, {
      parseMode: format === 'rich' ? 'MarkdownV2' : 'Markdown',
      replyToMessageId: Number(msgId),
    });
    return this.messageKey(msg.chat.id, msg.message_id);
  }

  async updateMessage(messageId: string, content: string): Promise<void> {
    const [chatId, msgId] = this.splitMessageKey(messageId);
    await this.client.editMessageText(Number(chatId), Number(msgId), content, {
      parseMode: 'Markdown',
    });
  }

  async sendCard(threadId: string, card: ImCard): Promise<string> {
    const text = (card.payload as { text?: string })?.text ?? String(card.payload);
    return this.sendMessage(threadId, text, 'rich');
  }

  async updateCard(messageId: string, card: ImCard): Promise<void> {
    const text = (card.payload as { text?: string })?.text ?? String(card.payload);
    await this.updateMessage(messageId, text);
  }

  // ── 用户 / 消息 ───────────────────────────────────────────────────────

  async resolveUsers(identifiers: string[]): Promise<ImUser[]> {
    const out: ImUser[] = [];
    for (const id of identifiers) {
      const cached = this.userCache.get(id);
      out.push(cached ?? { id, identifier: id });
    }
    return out;
  }

  async sendDirectMessage(userId: string, content: string): Promise<void> {
    await this.client.sendMessage(Number(userId), content, { parseMode: 'Markdown' });
  }

  async getThreadMessages(threadId: string, limit: number): Promise<ImMessage[]> {
    const { chatId, threadId: tgThread } = this.parseThreadId(threadId);
    const updates = await this.client.getUpdates(this.offset, { limit });
    // 简化：Telegram getUpdates 不提供按 chat 拉历史聊天的稳定接口，这里返回
    // 内存中最近收到的该 thread 消息。生产可扩展为 getChatHistory。
    const msgs: ImMessage[] = [];
    for (const u of updates) {
      if (!u.message) continue;
      if (u.message.chat.id !== chatId) continue;
      const m = this.toImMessage(u.message);
      if (this.threadKey(u.message) === threadId) msgs.push(m);
    }
    return msgs.slice(-limit);
  }

  async downloadAttachment(messageId: string, resourceKey: string): Promise<string> {
    // resourceKey 是 Telegram file_id；messageId 用于推导临时目录。
    if (!resourceKey) throw new Error('Telegram downloadAttachment 需要 file_id');
    const dest = `/tmp/tg-${Date.now()}-${resourceKey.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return this.client.downloadFile(resourceKey, dest);
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const [chatId, msgId] = this.splitMessageKey(messageId);
    const emoji = KNOWN_EMOJI[emojiType] ?? '👍';
    await this.client.setMessageReaction(Number(chatId), Number(msgId), emoji);
    return `${chatId}:${msgId}:${emoji}`;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    // Telegram 的 removeReaction = 把 reaction 置空（清空 emoji list）。
    const [chatId, msgId] = String(messageId).split(':');
    await this.client.setMessageReaction(Number(chatId), Number(msgId), '');
  }

  // ── 轮询 ──────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.client.getUpdates(this.offset, { timeout: this.pollTimeoutSec });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.dispatch(update);
        }
      } catch (err) {
        // 网络抖动 / 冲突：静默重试，不崩 daemon。
        await new Promise((r) => setTimeout(r, this.pollIntervalMs * 5));
        continue;
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  private async dispatch(update: TgUpdate): Promise<void> {
    if (!this.handler) return;

    if (update.message) {
      const senderId = update.message.from?.id;
      if (this.allowedUserIds.size > 0 && senderId !== undefined && !this.allowedUserIds.has(senderId)) {
        return; // 非白名单用户，忽略
      }
      const msg = this.toImMessage(update.message);
      const chatType = update.message.chat.type === 'private' ? ('p2p' as const) : ('group' as const);
      await this.handler.onNewTopic(msg, this.threadKey(update.message), chatType);
      return;
    }

    if (update.callback_query?.message) {
      const action: ImCardAction = {
        actionType: update.callback_query.data ?? '',
        threadId: this.threadKey(update.callback_query.message),
        operatorId: update.callback_query.from ? String(update.callback_query.from.id) : undefined,
        value: {},
      };
      await this.handler.onCardAction(action);
    }
  }

  // ── 映射 ──────────────────────────────────────────────────────────────

  private threadKey(msg: TgMessage): string {
    const thread = msg.message_thread_id ?? msg.reply_to_message?.message_thread_id;
    if (msg.chat.type === 'private') return `tg:${msg.chat.id}`;
    return thread ? `tg:${msg.chat.id}:${thread}` : `tg:${msg.chat.id}`;
  }

  private parseThreadId(threadId: string): { chatId: number; threadId?: number } {
    const parts = threadId.split(':');
    const chatId = Number(parts[1]);
    const thread = parts[2] ? Number(parts[2]) : undefined;
    return { chatId, threadId: thread };
  }

  private messageKey(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  private splitMessageKey(messageId: string): [string, string] {
    const idx = messageId.indexOf(':');
    if (idx < 0) return [messageId, messageId];
    return [messageId.slice(0, idx), messageId.slice(idx + 1)];
  }

  private toImMessage(msg: TgMessage): ImMessage {
    const senderId = msg.from ? String(msg.from.id) : String(msg.chat.id);
    const content = msg.text ?? msg.caption ?? '';
    const attachments: ImAttachment[] = [];
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      attachments.push({ type: 'image', path: largest.file_id, name: `${largest.file_id}.jpg` });
    }
    if (msg.document) {
      attachments.push({
        type: 'file',
        path: msg.document.file_id,
        name: msg.document.file_name ?? msg.document.file_id,
      });
    }
    this.userCache.set(senderId, { id: senderId, identifier: msg.from?.username ?? senderId });
    return {
      id: this.messageKey(msg.chat.id, msg.message_id),
      threadId: this.threadKey(msg),
      senderId,
      senderType: msg.from?.is_bot ? 'bot' : 'user',
      content,
      msgType: msg.voice || msg.audio ? 'audio' : msg.photo ? 'image' : msg.document ? 'file' : 'text',
      attachments: attachments.length ? attachments : undefined,
      createTime: new Date(msg.date * 1000).toISOString(),
    };
  }
}

/** Telegram 无卡片：用结构化文本渲染卡片标题/正文/状态。 */
class TelegramCardBuilder implements ImCardBuilder {
  buildSessionCard(opts: { sessionId: string; rootMessageId: string; terminalUrl: string; title: string }): ImCard {
    return {
      payload: {
        text: [
          `**${opts.title}**`,
          `\`\`\`\n会话: ${opts.sessionId}\n\`\`\``,
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