/**
 * 主 Agent 在一次 Pipeline 回合内可以请求的 Worker 写操作。
 * CLI 只负责解析参数；身份、权限、资源归属和状态流转由 Pipeline 决定。
 */
export type WorkerAgentCommand =
  | {
      type: "work.create";
      request: string;
    }
  | {
      type: "job.create";
      workId: string;
      workerProfileId: string;
      prompt: string;
      workdir?: string;
      dependsOn?: string[];
      idempotencyKey: string;
    }
  | {
      type: "cancel";
      id: string;
      /** 取消原因（可选），写入 job.error 供查询 */
      reason?: string;
    }
  | {
      type: "work.complete_recovery";
      workId: string;
      conclusion: string;
      force: true;
    }
  | {
      type: "config.draft";
      yamlText: string;
      baseVersion?: string;
    }
  | {
      type: "config.apply";
      draftId: string;
    }
  | {
      type: "config.rollback";
      version: string;
    };

export interface WorkerAgentCommandRequest {
  chatId: string;
  command: WorkerAgentCommand;
  /** 主 Agent 回合能力令牌；缺省或与当前活动回合不匹配时拒绝 */
  scheduleToken?: string;
}

export interface WorkerAgentCommandResult {
  output: string;
}
