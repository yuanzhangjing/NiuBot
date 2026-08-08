import fs from "node:fs";
import path from "node:path";
import { replaceFileSync } from "./platform/files.js";

export interface RestartState {
  id: string;
  phase: string;
  oldPid?: number;
  candidatePid?: number;
  candidateRelease?: string;
  previousRelease?: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  /** 本次重启是否由自动升级触发（NIUBOT_AUTO_UPDATE=1 写入）；供新引擎早晨汇报判定。 */
  autoUpdate?: boolean;
}

export function readRestartState(stateFile: string, expectedId?: string): RestartState | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as RestartState;
    if (
      typeof state.id !== "string"
      || typeof state.phase !== "string"
      || typeof state.startedAt !== "string"
      || typeof state.updatedAt !== "string"
    ) {
      return undefined;
    }
    return expectedId === undefined || state.id === expectedId ? state : undefined;
  } catch {
    return undefined;
  }
}

export class RestartStateWriter {
  readonly directory: string;
  readonly stateFile: string;

  constructor(readonly botDirectory: string, readonly id: string, readonly startedAt: string) {
    this.directory = path.join(botDirectory, "restart");
    this.stateFile = path.join(this.directory, "state.json");
  }

  write(phase: string, values: Partial<Omit<RestartState, "id" | "phase" | "startedAt" | "updatedAt">> = {}): RestartState {
    fs.mkdirSync(this.directory, { recursive: true });
    const previous = this.read();
    const state: RestartState = {
      id: this.id,
      phase,
      oldPid: values.oldPid ?? previous?.oldPid,
      candidatePid: values.candidatePid ?? previous?.candidatePid,
      candidateRelease: values.candidateRelease ?? previous?.candidateRelease,
      previousRelease: values.previousRelease ?? previous?.previousRelease,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      error: values.error,
      // 每次重启重置：autoUpdate 只反映「最近一次重启是否自动升级触发」，不继承旧值
      autoUpdate: values.autoUpdate,
    };
    const tempFile = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tempFile, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    replaceFileSync(tempFile, this.stateFile);
    return state;
  }

  read(): RestartState | undefined {
    return readRestartState(this.stateFile, this.id);
  }
}
