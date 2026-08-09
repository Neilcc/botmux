/**
 * 通道工厂 —— 按 bot 配置的 `channel` 字段构造对应的 ImAdapter。
 *
 * botmux 是「多 CLI × 多后端 × 多 IM」的横向架构。上游已实现 Telegram
 * （src/im/telegram/）与 Weixin（src/im/weixin/）两个 ImAdapter，但 daemon 的
 * 消息路由仍走飞书硬编码路径（im/lark/*），`channel` 字段此前只是配置面。
 *
 * 本文件是让 `channel` 字段真正生效的接线层：给定 BotConfig，返回该 bot 应
 * 使用的 ImAdapter，供 daemon 侧按通道路由。
 *
 * 覆盖：
 * - `lark`：返回 undefined（飞书通道仍走 daemon 现有硬编码路径，尚未收敛到本
 *   接口——见 README「多通道」）。
 * - `telegram`：返回 {@link TelegramAdapter}（上游实现，含单测
 *   test/telegram-adapter.test.ts）。
 * - `weixin`：返回 {@link WeixinAdapter}（上游实现，走 openclaw 扫码绑定的
 *   iLink 协议，凭证从 openclaw 账户文件读取）。
 */

import type { BotConfig } from '../bot-registry.js';
import type { ImAdapter } from './types.js';
import { TelegramAdapter } from './telegram/adapter.js';
import { WeixinAdapter } from './weixin/adapter.js';
import { loadWeixinAccountCredentials } from './weixin/client.js';

/**
 * 根据 bot 配置构造 ImAdapter。channel 缺省 = 'lark'（向后兼容）。
 * 对 lark 返回 undefined，表示「走 daemon 现有飞书路径」。
 */
export function createChannelAdapter(cfg: BotConfig): ImAdapter | undefined {
  const channel = cfg.channel ?? 'lark';
  switch (channel) {
    case 'telegram':
      if (!cfg.telegramBotToken) {
        throw new Error(`bot ${cfg.larkAppId}: channel=telegram 但缺少 telegramBotToken`);
      }
      return new TelegramAdapter({
        token: cfg.telegramBotToken,
        // allowedUsers 语义兼容：数字 id 白名单。
        allowedUserIds: cfg.allowedUsers
          ?.map((u) => Number(u))
          .filter((n) => Number.isFinite(n) && n > 0),
      });
    case 'weixin': {
      if (!cfg.wechatClawbotId) {
        throw new Error(`bot ${cfg.larkAppId}: channel=weixin 但缺少 wechatClawbotId`);
      }
      const accountId = cfg.wechatClawbotId;
      // 凭证从 openclaw 账户文件读取（需要先按 openclaw-weixin 扫码绑定）。
      const creds = loadWeixinAccountCredentials(accountId);
      return new WeixinAdapter({
        accountId,
        token: creds.token,
        baseUrl: creds.baseUrl,
        allowedUserIds: cfg.allowedUsers,
      });
    }
    case 'lark':
    default:
      return undefined; // 飞书通道仍走 daemon 现有硬编码路径
  }
}