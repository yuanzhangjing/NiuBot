import { randomUUID } from "node:crypto";

export type PipelineHealth = {
  state: "starting" | "running" | "stopping" | "stopped" | "degraded";
  startedAt: number;
  inflightRunIds: string[];
  lastError?: string;
};

export type ChatQueueState = {
  chatId: string;
  state: "idle" | "buffering" | "busy" | "stopped" | "degraded";
  activeRunId: string | null;
  bufferMessageIds: number[];
  pendingRunIds: string[];
  updatedAt: number;
  lastError?: string;
};

export type RunStage = "queued" | "agent_running" | "sending_response" | "done" | "failed" | "stopped";

export type RuntimeStateEventName =
  | "started"
  | "stage_changed"
  | "timeout"
  | "failed"
  | "stopped"
  | "done"
  | "failed_by_restart";

export type RuntimeStateEvent = {
  chatId: string;
  runId: string;
  messageIds: number[];
  stage: RunStage;
  event: RuntimeStateEventName;
  error?: string;
  elapsedMs: number;
};

export type RunState = {
  runId: string;
  chatId: string;
  triggerMessageIds: number[];
  triggerPlatformMsgIds: string[];
  replyToPlatformMsgId?: string;
  mergedText: string;
  stage: RunStage;
  startedAt: number;
  updatedAt: number;
  lastError?: string;
};

type RuntimeStateStoreOptions = {
  now?: () => number;
  createRunId?: () => string;
  onEvent?: (event: RuntimeStateEvent) => void;
};

type CreateRunInput = {
  chatId: string;
  triggerMessageIds: number[];
  triggerPlatformMsgIds: string[];
  replyToPlatformMsgId?: string;
  mergedText: string;
};

const TERMINAL_STAGES = new Set<RunStage>(["done", "failed", "stopped"]);

const ALLOWED_TRANSITIONS: Record<RunStage, RunStage[]> = {
  queued: ["agent_running", "failed", "stopped"],
  agent_running: ["sending_response", "done", "failed", "stopped"],
  sending_response: ["done", "failed", "stopped"],
  done: [],
  failed: [],
  stopped: [],
};

export class RuntimeStateStore {
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private readonly onEvent?: (event: RuntimeStateEvent) => void;
  private readonly pipelineHealth: PipelineHealth;
  private readonly chats = new Map<string, ChatQueueState>();
  private readonly runs = new Map<string, RunState>();

  constructor(options: RuntimeStateStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createRunId = options.createRunId ?? (() => randomUUID());
    this.onEvent = options.onEvent;
    this.pipelineHealth = {
      state: "running",
      startedAt: this.now(),
      inflightRunIds: [],
    };
  }

  getPipelineHealth(): PipelineHealth {
    return {
      ...this.pipelineHealth,
      inflightRunIds: [...this.pipelineHealth.inflightRunIds],
    };
  }

  getChatState(chatId: string): ChatQueueState {
    const state = this.ensureChatState(chatId);
    return cloneChatState(state);
  }

  getRun(runId: string): RunState | undefined {
    const run = this.runs.get(runId);
    return run ? cloneRunState(run) : undefined;
  }

  getRunsForChat(chatId: string): RunState[] {
    return [...this.runs.values()]
      .filter((run) => run.chatId === chatId)
      .map((run) => cloneRunState(run));
  }

  getActiveRun(chatId: string): RunState | null {
    const runId = this.ensureChatState(chatId).activeRunId;
    if (!runId) return null;
    const run = this.runs.get(runId);
    return run ? cloneRunState(run) : null;
  }

  createRun(input: CreateRunInput): RunState {
    const timestamp = this.now();
    const run: RunState = {
      runId: this.createRunId(),
      chatId: input.chatId,
      triggerMessageIds: [...input.triggerMessageIds],
      triggerPlatformMsgIds: [...input.triggerPlatformMsgIds],
      replyToPlatformMsgId: input.replyToPlatformMsgId,
      mergedText: input.mergedText,
      stage: "queued",
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    if (!run.replyToPlatformMsgId) {
      delete run.replyToPlatformMsgId;
    }

    this.runs.set(run.runId, run);
    this.setInflight(run.runId, true);

    const chat = this.ensureChatState(input.chatId);
    chat.state = "busy";
    chat.activeRunId = run.runId;
    chat.updatedAt = timestamp;
    delete chat.lastError;

    this.emitRunEvent(run, "started", timestamp);
    return cloneRunState(run);
  }

  markRunStage(runId: string, stage: RunStage, lastError?: string): RunState {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (!ALLOWED_TRANSITIONS[run.stage].includes(stage)) {
      const message = `Invalid run stage transition: ${run.stage} -> ${stage}`;
      this.recordError(run.chatId, message);
      throw new Error(message);
    }

    const timestamp = this.now();
    run.stage = stage;
    run.updatedAt = timestamp;
    if (lastError) {
      run.lastError = lastError;
    } else {
      delete run.lastError;
    }

    const chat = this.ensureChatState(run.chatId);
    chat.updatedAt = timestamp;
    if (lastError) {
      chat.lastError = lastError;
      this.pipelineHealth.lastError = lastError;
    }

    if (TERMINAL_STAGES.has(stage)) {
      this.setInflight(runId, false);
      if (chat.activeRunId === runId) {
        chat.activeRunId = null;
        chat.state = chat.bufferMessageIds.length > 0 ? "buffering" : "idle";
      }
    } else {
      chat.state = "busy";
      chat.activeRunId = runId;
      this.setInflight(runId, true);
    }

    this.emitRunEvent(run, eventForStage(stage), timestamp, lastError);
    return cloneRunState(run);
  }

  recordRunEvent(runId: string, event: RuntimeStateEventName, error?: string): void {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    this.emitRunEvent(run, event, this.now(), error);
  }

  updateChatBuffer(chatId: string, bufferMessageIds: number[]): ChatQueueState {
    const chat = this.ensureChatState(chatId);
    chat.bufferMessageIds = [...bufferMessageIds];
    chat.updatedAt = this.now();
    if (!chat.activeRunId && chat.state !== "stopped" && chat.state !== "degraded") {
      chat.state = chat.bufferMessageIds.length > 0 ? "buffering" : "idle";
    }
    return cloneChatState(chat);
  }

  markChatStopped(chatId: string, lastError?: string): ChatQueueState {
    const chat = this.ensureChatState(chatId);
    chat.state = "stopped";
    chat.updatedAt = this.now();
    if (lastError) {
      chat.lastError = lastError;
      this.pipelineHealth.lastError = lastError;
    }
    return cloneChatState(chat);
  }

  private ensureChatState(chatId: string): ChatQueueState {
    let state = this.chats.get(chatId);
    if (!state) {
      state = {
        chatId,
        state: "idle",
        activeRunId: null,
        bufferMessageIds: [],
        pendingRunIds: [],
        updatedAt: this.now(),
      };
      this.chats.set(chatId, state);
    }
    return state;
  }

  private setInflight(runId: string, inflight: boolean): void {
    const ids = this.pipelineHealth.inflightRunIds;
    const hasRun = ids.includes(runId);
    if (inflight && !hasRun) {
      ids.push(runId);
    }
    if (!inflight && hasRun) {
      this.pipelineHealth.inflightRunIds = ids.filter((id) => id !== runId);
    }
  }

  private recordError(chatId: string, error: string): void {
    const timestamp = this.now();
    const chat = this.ensureChatState(chatId);
    chat.lastError = error;
    chat.updatedAt = timestamp;
    this.pipelineHealth.lastError = error;
  }

  private emitRunEvent(
    run: RunState,
    event: RuntimeStateEventName,
    timestamp: number,
    error?: string,
  ): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({
        chatId: run.chatId,
        runId: run.runId,
        messageIds: [...run.triggerMessageIds],
        stage: run.stage,
        event,
        error,
        elapsedMs: Math.max(0, timestamp - run.startedAt),
      });
    } catch {
      // Runtime event persistence is diagnostic only; it must not block message handling.
    }
  }
}

function eventForStage(stage: RunStage): RuntimeStateEventName {
  if (stage === "done" || stage === "failed" || stage === "stopped") return stage;
  return "stage_changed";
}

function cloneChatState(state: ChatQueueState): ChatQueueState {
  return {
    ...state,
    bufferMessageIds: [...state.bufferMessageIds],
    pendingRunIds: [...state.pendingRunIds],
  };
}

function cloneRunState(state: RunState): RunState {
  return {
    ...state,
    triggerMessageIds: [...state.triggerMessageIds],
    triggerPlatformMsgIds: [...state.triggerPlatformMsgIds],
  };
}
