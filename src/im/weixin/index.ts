export {
  WeixinAdapter,
  type WeixinAdapterOptions,
} from './adapter.js';
export {
  WeixinClient,
  type WeixinInboundMessage,
  type WeixinUpdate,
  type WeixinMessageItem,
  loadWeixinAccountCredentials,
  weixinBodyFromItems,
  DEFAULT_WEIXIN_BASE_URL,
} from './client.js';