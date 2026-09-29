import { AsyncLocalStorage } from "node:async_hooks";

export interface TravelExecutionContext {
  runId: string;
  workerId: string;
  fence: number;
  signal: AbortSignal;
  assertCurrent: () => Promise<void>;
  emit: (event: Record<string, unknown>) => Promise<void>;
  reserveModel?: (provider: string, reservedTokens: number, signal?: AbortSignal) => Promise<(usage?: { input: number; output: number }) => Promise<void>>;
  track?: (completion: Promise<unknown>) => void;
  deadlineAt?: number;
  userId?: string;
  reserveJudgment?: (reservedTokens: number, retry: boolean) => Promise<(usage?: { input: number; output: number }) => Promise<void>>;
  cooldownJudgment?: (until: number) => Promise<void>;
  readStep?: <T>(key: string, input: unknown, execute: () => Promise<T>, ttlMs?: number) => Promise<T>;
  retryAttempt?: (key: string, mark?: boolean) => Promise<boolean>;
  defer?: { notBefore: number; waitReason: string } | null;
}

const execution = new AsyncLocalStorage<TravelExecutionContext>();

export function withTravelExecution<T>(context: TravelExecutionContext, task: () => T): T {
  return execution.run(context, task);
}

export function currentTravelExecution(): TravelExecutionContext | undefined {
  return execution.getStore();
}

/** Called at the persistence boundary as well as before tools. */
export async function assertTravelExecutionCurrent(): Promise<void> {
  const context = execution.getStore();
  if (!context) return;
  context.signal.throwIfAborted();
  await context.assertCurrent();
  context.signal.throwIfAborted();
}

export async function emitTravelExecution(event: Record<string, unknown>): Promise<void> {
  await execution.getStore()?.emit(event);
}
