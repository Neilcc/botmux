import type { ImAdapter } from './types.js';

/**
 * 通道注册表 —— 运行期保存「非飞书 bot 正在使用的 ImAdapter」。
 *
 * daemon 启动时，对 `channel` 为 weixin / telegram 的 bot，用
 * {@link createChannelAdapter} 构造 adapter 并注册到这里；出站（
 * `src/im/lark/client.ts` 的 sendMessage / replyMessage / updateMessage /
 * addReaction / deleteMessage）据此把对该 bot 的发送路由到对应通道，而不是
 * 飞书 Lark API。
 *
 * 飞书 bot（channel 为 lark 或缺省）从不注册，getChannelAdapter 返回 undefined，
 * 现有飞书出站路径字节不变 —— 这是「牵一发动全身」最小的回归面。
 */
const nonLarkAdapters = new Map<string, ImAdapter>();

export function registerChannelAdapter(larkAppId: string, adapter: ImAdapter): void {
  nonLarkAdapters.set(larkAppId, adapter);
}

export function getChannelAdapter(larkAppId: string): ImAdapter | undefined {
  return nonLarkAdapters.get(larkAppId);
}

export function unregisterChannelAdapter(larkAppId: string): void {
  nonLarkAdapters.delete(larkAppId);
}

export function hasNonLarkChannel(larkAppId: string): boolean {
  return nonLarkAdapters.has(larkAppId);
}