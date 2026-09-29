export interface ReadyRun { runId: string; userId: string; queueClass: string; updatedAt: number }

/** Weighted, work-conserving admission. Aging and per-user rotation prevent starvation. */
export function selectReadyRuns<T extends ReadyRun>(ready: T[], count: number, position: number, now: number): { runs: T[]; position: number } {
  const pending = [...ready].sort((a, b) => a.updatedAt - b.updatedAt || a.runId.localeCompare(b.runId));
  const selected: T[] = [];
  const served = new Map<string, number>();
  while (pending.length && selected.length < count) {
    const minimum = Math.min(...pending.map(run => served.get(run.userId) ?? 0));
    const fair = pending.filter(run => (served.get(run.userId) ?? 0) === minimum);
    const aged = fair.find(run => now - run.updatedAt >= 10_000);
    const preferred = position % 3 < 2 ? "interactive" : "continuation";
    const next = aged ?? fair.find(run => run.queueClass === preferred) ?? fair[0]!;
    pending.splice(pending.indexOf(next), 1); selected.push(next);
    served.set(next.userId, (served.get(next.userId) ?? 0) + 1); position++;
  }
  return { runs: selected, position };
}
