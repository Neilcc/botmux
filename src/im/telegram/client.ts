/**
 * 轻量 Telegram Bot API 客户端。基于 Node 内置 fetch，零第三方依赖。
 * 只覆盖 bidmux 通道层需要的端点；响应统一窄化为 Telegram 原生类型。
 */

const TELEGRAM_API = 'https://api.telegram.org';

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
  message_thread_id?: number;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  voice?: { file_id: string; duration: number };
  audio?: { file_id: string; duration: number };
  video?: { file_id: string; duration: number };
  sticker?: { file_id: string; emoji?: string };
  entities?: unknown[];
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
  message_reaction?: {
    chat: TgChat;
    message_id: number;
    new_reaction?: Array<{ type: string; emoji?: string }>;
  };
}

class TelegramApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class TelegramClient {
  private readonly base: string;
  private readonly token: string;
  private _me?: TgUser;

  constructor(token: string, opts: { apiUrl?: string } = {}) {
    this.token = token;
    this.base = (opts.apiUrl ?? TELEGRAM_API).replace(/\/$/, '');
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.base}/bot${this.token}/${method}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw new Error(`Telegram ${method} 网络失败: ${(err as Error).message}`);
    }
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!json.ok) {
      throw new TelegramApiError(json.error_code ?? -1, `${method} 失败: ${json.description ?? '未知'}`);
    }
    return json.result as T;
  }

  /** 获取 bot 自身信息（用于 getBotUserId）。 */
  async getMe(): Promise<TgUser> {
    if (!this._me) this._me = await this.call<TgUser>('getMe');
    return this._me;
  }

  /** 长轮询拉取更新。timeout 单位为秒。 */
  async getUpdates(offset?: number, opts: { timeout?: number; limit?: number } = {}): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', {
      offset,
      timeout: opts.timeout ?? 30,
      limit: opts.limit ?? 100,
      allowed_updates: ['message', 'callback_query', 'message_reaction'],
    });
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    opts: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'; replyToMessageId?: number } = {},
  ): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode ?? 'Markdown',
      reply_to_message_id: opts.replyToMessageId,
    });
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' } = {},
  ): Promise<TgMessage> {
    return this.call<TgMessage>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts.parseMode ?? 'Markdown',
    });
  }

  /**
   * 用 emoji 给消息加 Reaction。Telegram 原生支持，直接映射 ImAdapter.addReaction。
   * 返回一个稳定 id（这里用 chatId:messageId:emoji 拼成），removeReaction 据此重放。
   */
  async setMessageReaction(
    chatId: number | string,
    messageId: number,
    emoji: string,
  ): Promise<boolean> {
    return this.call<boolean>('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
  }

  /** 下载文件到本地，返回磁盘路径。resourceKey 为 Telegram file_id。 */
  async downloadFile(fileId: string, destPath: string): Promise<string> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new Error(`Telegram 无法解析 file_path for ${fileId}`);
    const url = `${this.base}/file/bot${this.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram 下载文件失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, buf);
    return destPath;
  }
}