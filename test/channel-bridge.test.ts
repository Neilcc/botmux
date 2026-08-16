import { describe, it, expect, vi } from 'vitest';
import {
  imMessageToLarkData,
  buildChannelImEventHandler,
  extractChannelCardText,
} from '../src/im/channel-bridge.js';
import type { EventHandlers } from '../src/im/lark/event-dispatcher.js';
import type { ImMessage } from '../src/im/types.js';

/**
 * 验证 channel-bridge 的适配逻辑：
 * 1. imMessageToLarkData 合成出既有 handleNewTopic/handleThreadReply 需要的
 *    最小飞书记事件 data（sender.sender_id.open_id / message_type / content…）。
 * 2. buildChannelImEventHandler 按 isSessionOwner 决定续话 vs 开新话题。
 * 3. extractChannelCardText 从卡片 JSON 提取纯文本。
 */

function makeMsg(over: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'wx-msg-1',
    threadId: 'wx:acct:o9cquser',
    senderId: 'o9cquser',
    senderType: 'user',
    content: 'hello weixin',
    msgType: 'text',
    createTime: '2026-08-10T00:00:00.000Z',
    ...over,
  };
}

function makeHandlers(): {
  handlers: EventHandlers;
  calls: Array<{ kind: string; data: any; ctx: any }>;
} {
  const calls: Array<{ kind: string; data: any; ctx: any }> = [];
  const handlers: EventHandlers = {
    handleCardAction: vi.fn() as any,
    handleNewTopic: vi.fn(async (data: any, ctx: any) => { calls.push({ kind: 'newTopic', data, ctx }); }),
    handleThreadReply: vi.fn(async (data: any, ctx: any) => { calls.push({ kind: 'threadReply', data, ctx }); }),
  };
  return { handlers, calls };
}

describe('imMessageToLarkData', () => {
  it('合成出 handleNewTopic 需要的 sender/message 最小结构', () => {
    const data = imMessageToLarkData(makeMsg(), 'p2p');
    expect(data.sender.sender_id.open_id).toBe('o9cquser');
    expect(data.sender.sender_type).toBe('user');
    expect(data.message.message_type).toBe('text');
    expect(JSON.parse(data.message.content).text).toBe('hello weixin');
    expect(data.message.message_id).toBe('wx-msg-1');
    expect(data.message.chat_id).toBe('wx:acct:o9cquser');
  });

  it('bot 发送方映射为飞书 app sender_type', () => {
    const data = imMessageToLarkData(makeMsg({ senderType: 'bot' }), 'p2p');
    expect(data.sender.sender_type).toBe('app');
  });
});

describe('buildChannelImEventHandler', () => {
  it('无活跃会话时走 handleNewTopic，anchor=threadId', async () => {
    const { handlers, calls } = makeHandlers();
    const bridge = buildChannelImEventHandler(handlers, 'lark-app-1');
    await bridge.onNewTopic(makeMsg(), 'wx:acct:o9cquser', 'p2p');
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('newTopic');
    expect(calls[0].ctx.larkAppId).toBe('lark-app-1');
    expect(calls[0].ctx.anchor).toBe('wx:acct:o9cquser');
    expect(calls[0].ctx.chatType).toBe('p2p');
    expect(calls[0].ctx.scope).toBe('thread');
  });

  it('已有活跃会话时走 handleThreadReply（续话，不重复建会话）', async () => {
    const { handlers, calls } = makeHandlers();
    handlers.isSessionOwner = vi.fn(() => true);
    const bridge = buildChannelImEventHandler(handlers, 'lark-app-1');
    await bridge.onNewTopic(makeMsg(), 'wx:acct:o9cquser', 'p2p');
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('threadReply');
  });

  it('onThreadReply 直接走 handleThreadReply', async () => {
    const { handlers, calls } = makeHandlers();
    const bridge = buildChannelImEventHandler(handlers, 'lark-app-1');
    await bridge.onThreadReply(makeMsg(), 'wx:acct:o9cquser');
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('threadReply');
    expect(calls[0].ctx.anchor).toBe('wx:acct:o9cquser');
  });
});

describe('extractChannelCardText', () => {
  it('从 markdown/div 卡片提取纯文本', () => {
    const card = JSON.stringify({
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '会话卡片' } },
      body: {
        elements: [
          { tag: 'markdown', content: '**foo**' },
          { tag: 'div', text: { tag: 'plain_text', content: 'bar' } },
        ],
      },
    });
    const text = extractChannelCardText(card);
    expect(text).toContain('foo');
    expect(text).toContain('bar');
  });

  it('非 JSON 输入原样返回', () => {
    expect(extractChannelCardText('not-a-card')).toBe('not-a-card');
  });
});