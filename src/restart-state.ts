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
  /** 本次重启是否自动升级触发：构造时固定，write 自动带上（贯穿整个 worker 生命周期） */
  private readonly autoUpdate: boolean;

  constructor(readonly botDirectory: string, readonly id: string, readonly startedAt: string, autoUpdate = false) {
    this.directory = path.join(botDirectory, "restart");
    this.stateFile = path.join(this.directory, "state.json");
    this.autoUpdate = autoUpdate;
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
      // 本次重启的属性，构造时固定，每次 write 都带上（不被后续 write 覆盖丢失）
      autoUpdate: this.autoUpdate,
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
