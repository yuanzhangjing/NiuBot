/**
 * NiuBot Plugin API — 供自定义 backend 插件使用。
 *
 * 用法：import { CliAgentBackend, buildNiubotEnv } from "niubot/plugin";
 */

export { CliAgentBackend, buildNiubotEnv } from "./agent/cli-base.js";
export type { BaseCliSession, ParsedOutput } from "./agent/cli-base.js";
export type { AgentBackend, AgentSession, AgentResponse, SessionConfig, ModelTier } from "./agent/types.js";
