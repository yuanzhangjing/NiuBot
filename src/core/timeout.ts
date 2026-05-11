export class TimeoutError extends Error {
  readonly code = "TIMEOUT";

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(options: {
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fn: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const { label, timeoutMs, signal, fn } = options;

  if (signal?.aborted) {
    throw getAbortReason(signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectExternalAbort: ((reason: unknown) => void) | undefined;

  const abortFromExternalSignal = () => {
    const reason = getAbortReason(signal);
    controller.abort(reason);
    rejectExternalAbort?.(reason);
  };

  signal?.addEventListener("abort", abortFromExternalSignal, { once: true });

  try {
    const operation = fn(controller.signal);
    const externalAbort = signal
      ? new Promise<never>((_, reject) => {
          rejectExternalAbort = reject;
        })
      : undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new TimeoutError(label, timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });

    return await Promise.race(externalAbort ? [operation, timeout, externalAbort] : [operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    rejectExternalAbort = undefined;
    signal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

function getAbortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("aborted");
}
