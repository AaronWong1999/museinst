



export const DEADLINE_BUDGETS_MS = {

  modelRequest: 60_000,

  imapCommand: 30_000,
  /** Telegram send */
  telegramSend: 20_000,

  foregroundTurn: 120_000,

  browserJobDefault: 6 * 60_000,
  browserJobCap: 10 * 60_000,
} as const;

export type DeadlineBudgetKind = keyof typeof DEADLINE_BUDGETS_MS;

export class DeadlineExceededError extends Error {
  readonly operation: string;
  readonly budgetMs: number;

  readonly quarantined = true;
  constructor(operation: string, budgetMs: number) {
    super(`deadline_exceeded:${operation}:${budgetMs}ms`);
    this.name = "DeadlineExceededError";
    this.operation = operation;
    this.budgetMs = budgetMs;
  }
}

export interface DeadlineOptions {
  operation: string;
  budgetMs: number;

  onLateResult?: (value: unknown) => void;
}






export async function withDeadline<T>(promise: Promise<T>, opts: DeadlineOptions): Promise<T> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {



    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { opts.onLateResult?.(undefined); } catch {               }
      reject(new DeadlineExceededError(opts.operation, opts.budgetMs));
    }, opts.budgetMs);
  });



  const guarded = promise.then(
    (v) => {
      if (settled) {
        try { opts.onLateResult?.(v); } catch {               }
        throw new DeadlineExceededError(opts.operation, opts.budgetMs);
      }
      return v;
    },
    (e) => {
      if (settled) {
        try { opts.onLateResult?.(undefined); } catch {               }
        throw new DeadlineExceededError(opts.operation, opts.budgetMs);
      }
      throw e;
    },
  );
  guarded.catch(() => {});
  try {
    const value = await Promise.race([guarded, timeout]);
    return value;
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}



export async function fetchWithDeadline(
  input: string,
  init: RequestInit | undefined,
  opts: { operation: string; budgetMs: number },
): Promise<Response> {
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), opts.budgetMs);
  try {
    const existing = init?.signal;
    if (existing) {
      if (existing.aborted) controller.abort();
      else existing.addEventListener("abort", () => controller.abort(), { once: true });
    }


    const doFetch = fetch(input, { ...init, signal: controller.signal });

    (doFetch as Promise<Response>).catch(() => {});
    return await withDeadline(doFetch, { operation: opts.operation, budgetMs: opts.budgetMs, onLateResult: () => {} });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new DeadlineExceededError(opts.operation, opts.budgetMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}


export function isDeadlineRetryableForRead(e: unknown): boolean {
  return e instanceof DeadlineExceededError;
}
