/**
 * 微信 Clawbot 通道 —— 轻量 HTTP 客户端。
 *
 * 基于 Node 内置 fetch，零第三方依赖。协议镜像自 openclaw-weixin 插件
 * （@tencent-weixin/openclaw-weixin v2.4.6）的 api.js / send.js / inbound.js：
 *   - 入站：长轮询 `POST {base}/ilink/bot/getupdates`，返回 `{ret, msgs, get_updates_buf}`
 *   - 出站：`POST {base}/ilink/bot/sendmessage`
 * 请求头带 `iLink-App-Id` / `iLink-App-ClientVersion` / `X-WECHAT-UIN` /
 * `Authorization: Bearer <token>`，body 带 `base_info`。
 *
 * 凭证（token + baseUrl + accountId）由微信 QR 扫码绑定产生，openclaw 只是用来
 * 扫码产 token；本客户端运行时不需要 openclaw。默认从 openclaw 的账户文件读取
 * （`~/.openclaw/openclaw-weixin/accounts/<accountId>.json`），也允许显式传 token。
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** iLink-App-Id：openclaw-weixin 插件 package.json 顶层 ilink_appid 字段当前为空。 */
const ILINK_APP_ID = '';
/** iLink-App-ClientVersion: uint32 0x00MMNNPP（major<<16 | minor<<8 | patch）。 */
function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((p) => parseInt(p, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const CHANNEL_VERSION = '2.4.6';
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

/** 长轮询默认超时（与服务端 hold 时长匹配）。 */
const LONG_POLL_TIMEOUT_MS = 35_000;
/** 普通 API 请求超时。 */
const API_TIMEOUT_MS = 15_000;

/** proto 枚举（镜像插件 types.js）。 */
export const WeixinMessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const WeixinMessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const WeixinMessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

export interface WeixinUpdate {
  ret: number;
  msgs?: WeixinInboundMessage[];
  get_updates_buf?: string;
  errmsg?: string;
}

export interface WeixinInboundMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
  run_id?: string;
  msg_id?: string;
  create_time_ms?: number;
}

export interface WeixinMessageItem {
  type: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  image_item?: unknown;
  video_item?: unknown;
  file_item?: unknown;
  ref_msg?: unknown;
}

export interface WeixinSendOptions {
  timeoutMs?: number;
}

/** 提取一条消息的纯文本（趋同插件 bodyFromItemList，含语音转文字）。 */
export function weixinBodyFromItems(itemList?: WeixinMessageItem[]): string {
  if (!itemList?.length) return '';
  for (const item of itemList) {
    if (item.type === WeixinMessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item.type === WeixinMessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return '';
}

/** 默认 baseUrl。 */
export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** 从 openclaw 账户文件读取凭证（token/baseUrl/userId）。 */
export function loadWeixinAccountCredentials(accountId: string): {
  token: string;
  baseUrl: string;
} {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), '.openclaw');
  const candidates = [
    join(stateDir, 'openclaw-weixin', 'accounts', `${accountId}.json`),
    join(stateDir, 'openclaw-weixin', 'accounts', `${accountId}@im.bot.json`),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      const token = typeof raw?.token === 'string' ? raw.token : '';
      const baseUrl = typeof raw?.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : DEFAULT_WEIXIN_BASE_URL;
      if (token) return { token, baseUrl };
    } catch {
      // try next candidate
    }
  }
  throw new Error(`weixin account credentials not found for accountId=${accountId} (looked in ${candidates.join(', ')})`);
}

/** X-WECHAT-UIN：随机 uint32 -> decimal string -> base64。 */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function buildBaseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: 'OpenClaw' };
}

export class WeixinClient {
  private readonly base: string;
  private readonly token: string;
  private readonly accountId: string;
  private getUpdatesBuf = '';
  private longPolling = false;

  /** accountId:userId -> context_token（出站必须原样带回）。 */
  private readonly contextTokens = new Map<string, string>();

  constructor(opts: {
    accountId: string;
    token: string;
    baseUrl?: string;
    contextTokenFile?: string;
  }) {
    this.accountId = opts.accountId;
    this.token = opts.token;
    this.base = ensureTrailingSlash((opts.baseUrl ?? DEFAULT_WEIXIN_BASE_URL).replace(/\/$/, ''));
    if (opts.contextTokenFile) this.restoreContextTokens(opts.contextTokenFile);
  }

  get account(): string {
    return this.accountId;
  }

  // ── 上下文 token（按 user 缓存，出站必须带回）──────────────────────────
  setContextToken(userId: string, token: string): void {
    this.contextTokens.set(this.tokenKey(userId), token);
  }
  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(this.tokenKey(userId));
  }
  private tokenKey(userId: string): string {
    return `${this.accountId}:${userId}`;
  }

  private restoreContextTokens(filePath: string): void {
    try {
      if (!existsSync(filePath)) return;
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && v) {
          const dot = k.indexOf(':');
          if (dot < 0) continue;
          const account = k.slice(0, dot);
          const userId = k.slice(dot + 1);
          if (account === this.accountId) this.contextTokens.set(this.tokenKey(userId), v);
        }
      }
    } catch {
      // ignore restore errors
    }
  }

  private persistContextTokens(filePath: string): void {
    try {
      const prefix = `${this.accountId}:`;
      const out: Record<string, string> = {};
      for (const [k, v] of this.contextTokens) {
        if (k.startsWith(prefix)) out[k] = v;
      }
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, JSON.stringify(out), 'utf-8');
    } catch {
      // best-effort
    }
  }

  // ── 请求 ──────────────────────────────────────────────────────────────
  private buildHeaders(bearer: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    };
    if (bearer && this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async post<T>(endpoint: string, body: unknown, timeoutMs: number): Promise<T> {
    const res = await fetch(new URL(endpoint, this.base).toString(), {
      method: 'POST',
      headers: this.buildHeaders(true),
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`weixin ${endpoint} HTTP ${res.status}: ${raw}`);
    return JSON.parse(raw) as T;
  }

  /** 长轮询拉取更新。超时/空响应返回空列表（正常控制流）。 */
  async getUpdates(opts: { timeoutMs?: number; abortSignal?: AbortSignal } = {}): Promise<WeixinInboundMessage[]> {
    const timeoutMs = opts.timeoutMs ?? LONG_POLL_TIMEOUT_MS;
    let res: WeixinUpdate;
    try {
      res = await this.post<WeixinUpdate>(
        'ilink/bot/getupdates',
        JSON.stringify({
          get_updates_buf: this.getUpdatesBuf ?? '',
          base_info: buildBaseInfo(),
        }),
        timeoutMs,
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return []; // 长轮询超时是正常退避信号
      }
      throw err;
    }
    if (res && typeof res.get_updates_buf === 'string') {
      this.getUpdatesBuf = res.get_updates_buf;
    }
    return res?.msgs ?? [];
  }

  /** 发送一条文本消息。contextToken 若缺失则用缓存（按 to 用户）。 */
  async sendText(toUserId: string, text: string, opts: WeixinSendOptions = {}): Promise<string> {
    const contextToken = this.getContextToken(toUserId);
    const clientId = `bmx-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: WeixinMessageType.BOT,
        message_state: WeixinMessageState.FINISH,
        item_list: text
          ? [{ type: WeixinMessageItemType.TEXT, text_item: { text } }]
          : [],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
    };
    try {
      await this.post<unknown>('ilink/bot/sendmessage', body, opts.timeoutMs ?? API_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`weixin sendText to=${toUserId} failed: ${(err as Error).message}`);
    }
    return clientId;
  }

  /**
   * 处理一条入站消息：缓存它携带的 context_token 并持久化。返回消息体文本。
   * 调用方负责把 text 交给 botmux 会话。
   */
  consumeInbound(msg: WeixinInboundMessage, contextTokenFile?: string): string {
    if (msg.from_user_id && msg.context_token) {
      this.setContextToken(msg.from_user_id, msg.context_token);
      if (contextTokenFile) this.persistContextTokens(contextTokenFile);
    }
    return weixinBodyFromItems(msg.item_list);
  }
}