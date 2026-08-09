import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramAdapter } from '../src/im/telegram/adapter.js';

/**
 * 用本地 mock HTTP 服务模拟 Telegram Bot API，验证：
 * 1. getMe 拿到 bot id
 * 2. 长轮询把收到的 message 派发成 ImMessage 并 trigger onNewTopic
 * 3. sendMessage / updateMessage / addReaction 走对端点、参数正确
 */

function makeMockServer() {
  const calls: Array<{ method: string; body: unknown }> = [];
  const pending: Array<unknown> = [];
  let me = { id: 12345, is_bot: true, first_name: 'testbot' };

  const server = {
    calls,
    pushUpdate(u: unknown) {
      pending.push(u);
    },
    setMe(m: unknown) {
      me = m as typeof me;
    },
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const seg = url.pathname.split('/');
      const method = seg[seg.length - 1];
      const body = (await req.json()) as Record<string, unknown>;
      calls.push({ method, body });
      let result: unknown;
      switch (method) {
        case 'getMe':
          result = me;
          break;
        case 'getUpdates':
          result = pending.splice(0, pending.length).map((u, i) => ({ update_id: 100 + i, ...(u as object) }));
          break;
        case 'sendMessage':
          result = { message_id: 777, chat: { id: body.chat_id }, text: body.text };
          break;
        case 'editMessageText':
          result = { message_id: body.message_id, chat: { id: body.chat_id }, text: body.text };
          break;
        case 'setMessageReaction':
          result = true;
          break;
        default:
          result = { ok: true };
      }
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
  return server;
}

async function startAdapter(server: { handle: (req: Request) => Promise<Response> }) {
  const adapter = new TelegramAdapter({
    token: '123:abc',
    apiUrl: 'http://127.0.0.1:1/mock', // apiUrl 会被 mock fetch 拦截
    pollIntervalMs: 10,
    pollTimeoutSec: 1,
    allowedUserIds: [999],
  });
  // 拦截全局 fetch，指向本地 mock
  const onNewTopic = vi.fn();
  const onThreadReply = vi.fn();
  const onCardAction = vi.fn();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return server.handle(new Request('http://127.0.0.1/mock/' + new URL(String(input)).pathname.split('/bot')[1], init));
  }) as typeof fetch;
  await adapter.start({ onNewTopic, onThreadReply, onCardAction });
  return { adapter, onNewTopic, onThreadReply, origFetch };
}

describe('TelegramAdapter', () => {
  let server: ReturnType<typeof makeMockServer>;
  let origFetch: typeof fetch;

  beforeEach(() => {
    server = makeMockServer();
  });

  it('getBotUserId 返回 getMe 的 id', async () => {
    const { adapter, origFetch: of } = await startAdapter(server);
    origFetch = of;
    expect(adapter.getBotUserId()).toBe('12345');
    await adapter.stop();
    globalThis.fetch = origFetch;
  });

  it('收到私聊消息时派发 onNewTopic，threadId 映射为 tg:<chat>', async () => {
    const s = makeMockServer();
    const { adapter, onNewTopic, origFetch: of } = await startAdapter(s);
    origFetch = of;
    s.pushUpdate({
      message: {
        message_id: 1,
        from: { id: 999, is_bot: false, first_name: 'u' },
        chat: { id: 888, type: 'private' },
        date: 1_700_000_000,
        text: '你好',
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(onNewTopic).toHaveBeenCalledTimes(1);
    const [msg, chatId, chatType] = onNewTopic.mock.calls[0];
    expect(chatId).toBe('tg:888');
    expect(chatType).toBe('p2p');
    expect(msg.content).toBe('你好');
    expect(msg.senderId).toBe('999');
    expect(msg.msgType).toBe('text');
    await adapter.stop();
    globalThis.fetch = origFetch;
  });

  it('sendMessage 用 richtext 时走 MarkdownV2', async () => {
    const s = makeMockServer();
    const { adapter, origFetch: of } = await startAdapter(s);
    origFetch = of;
    await adapter.sendMessage('tg:888', '**bold**', 'rich');
    const call = s.calls.find((c) => c.method === 'sendMessage');
    expect(call).toBeTruthy();
    expect((call!.body as { chat_id: number }).chat_id).toBe(888);
    expect((call!.body as { parse_mode: string }).parse_mode).toBe('MarkdownV2');
    await adapter.stop();
    globalThis.fetch = origFetch;
  });

  it('addReaction / updateMessage 走对应端点', async () => {
    const s = makeMockServer();
    const { adapter, origFetch: of } = await startAdapter(s);
    origFetch = of;
    await adapter.updateMessage('888:5', 'new text');
    expect(s.calls.some((c) => c.method === 'editMessageText')).toBe(true);
    const rid = await adapter.addReaction('888:5', 'thumbsup');
    expect(s.calls.some((c) => c.method === 'setMessageReaction')).toBe(true);
    expect(rid).toBe('888:5:👍');
    await adapter.stop();
    globalThis.fetch = origFetch;
  });
});