/**
 * IM 平台适配层接口。
 * 新增平台只需实现 PlatformAdapter，不改 Core。
 */

import type { NormalizedMessage, TransportClient } from "../transport/types.js";

export type { MentionInfo, MessageNode, NormalizedMessage } from "../transport/types.js";

export type MessageHandler = (msg: NormalizedMessage) => void | Promise<void>;

export interface PlatformAdapter extends TransportClient {
  /** 注册消息回调 */
  onMessage(handler: MessageHandler): void;

  /** 启动（连接 WebSocket 等） */
  start(): Promise<void>;

  /** 停止 */
  stop(): Promise<void>;
}
