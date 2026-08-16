import type { RoutingContext, EventHandlers } from './lark/event-dispatcher.js';
import type { ImEventHandler, ImMessage } from './types.js';

/**
 * 把飞书硬编码的 {@link EventHandlers} 桥接到 ImAdapter 的 {@link ImEventHandler}。
 *
 * 背景：daemon 的消息路由 `botEventHandlers` 签名是 `(data, ctx)`（data 是飞书
 * 事件结构，ctx 是 {@link RoutingContext}），而预留的 ImAdapter 是 `(msg, ...)`
 * （msg 是 {@link ImMessage}）。两者不一致，所以新通道（weixin / telegram）要写
 * 一层适配，把 ImMessage 合成一个「最小飞书记事件」`data` 再喂既有 handler，
 * 从而复用全部会话 / worker / CLI 逻辑，且不触碰飞书主路径。
 *
 * 合成 data 只填充既有 handler 真正读的字段（sender.sender_id.open_id、
 * sender.sender_type、message.message_type / content / message_id / create_time），
 * 其余（mentions / merge_forward / interactive 等）天然走空分支。
 */

/** 把一条跨通道 ImMessage 合成成飞书事件 data 的最小可路由结构。 */
export function imMessageToLarkData(msg: ImMessage, chatType: 'group' | 'p2p'): any {
  return {
    sender: {
      sender_id: { open_id: msg.senderId },
      sender_type: msg.senderType === 'bot' ? 'app' : 'user',
    },
    message: {
      message_id: msg.id,
      // 跨通道统一按 text 喂入（图片/文件暂以文本占位，媒体映射另列后续增量）。
      message_type: 'text',
      content: JSON.stringify({ text: msg.content }),
      create_time: msg.createTime,
      chat_id: msg.threadId,
    },
  };
}

function buildCtx(
  msg: ImMessage,
  chatType: 'group' | 'p2p',
  scope: 'thread' | 'chat',
  anchor: string,
  larkAppId: string,
): RoutingContext {
  return {
    chatId: msg.threadId,
    messageId: msg.id,
    chatType,
    scope,
    anchor,
    larkAppId,
  };
}

/**
 * 构造一个 ImEventHandler，把跨通道入站转成既有 botEventHandlers 调用。
 * 已有活跃会话的用户消息走 handleThreadReply（续话），否则 handleNewTopic
 * （开新话题）——用 daemon 自己的 isSessionOwner 判断，避免重复建会话。
 */
export function buildChannelImEventHandler(
  handlers: EventHandlers,
  larkAppId: string,
): ImEventHandler {
  return {
    async onNewTopic(msg, _chatId, chatType) {
      const data = imMessageToLarkData(msg, chatType);
      if (handlers.isSessionOwner?.(msg.threadId, larkAppId)) {
        await handlers.handleThreadReply(data, buildCtx(msg, chatType, 'thread', msg.threadId, larkAppId));
      } else {
        await handlers.handleNewTopic(data, buildCtx(msg, chatType, 'thread', msg.threadId, larkAppId));
      }
    },
    async onThreadReply(msg, threadId) {
      const data = imMessageToLarkData(msg, 'p2p');
      await handlers.handleThreadReply(data, buildCtx(msg, 'p2p', 'thread', threadId, larkAppId));
    },
    async onCardAction() {
      // 非飞书通道无卡片动作。
    },
  };
}

/** 从 Lark 卡片 JSON 尽力提取可读文本（非飞书通道把卡片渲染成纯文本）。 */
export function extractChannelCardText(cardJson: string): string {
  try {
    const card = JSON.parse(cardJson);
    const parts: string[] = [];
    walkCard(card, parts);
    const text = parts.filter(Boolean).join('\n').trim();
    if (text) return text;
  } catch {
    // 非 JSON：原样返回。
  }
  return cardJson;
}

function walkCard(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) walkCard(n, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const tag = obj.tag;
    if (tag === 'markdown' || tag === 'lark_md' || tag === 'div' || tag === 'note' || tag === 'shortcut') {
      const content =
        obj.content
        ?? (obj.text && (obj.text as Record<string, unknown>).content);
      if (typeof content === 'string' && content.trim()) out.push(content.trim());
      return;
    }
    for (const v of Object.values(obj)) walkCard(v, out);
  }
}