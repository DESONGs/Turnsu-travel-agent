// Capacity arithmetic only. No network, credentials, product execution or load test.
import { readFile } from 'node:fs/promises';

const inputUrl = process.argv[2] ?? new URL('./capacity-500-input.json', import.meta.url);
const a = JSON.parse(await readFile(inputUrl, 'utf8'));
for (const [key, value] of Object.entries(a)) {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`Invalid nonnegative numeric assumption: ${key}`);
  }
}
for (const key of ['meanTurnSeconds', 'illustrativeWorkerSafeTurnSlots']) {
  if (!(a[key] > 0)) throw new Error(`Positive assumption required: ${key}`);
}
const factor = 1 + a.headroomFraction;
const turnsPerSecond = a.activePlanningTurns / a.meanTurnSeconds;
const modelRequestsPerMinute = a.activePlanningTurns * a.meanModelCallsPerTurn * 60 / a.meanTurnSeconds;
const modelRequestsPerSecond = modelRequestsPerMinute / 60;
const inputTokensPerMinute = modelRequestsPerMinute * a.meanInputTokensPerCall;
const outputTokensPerMinute = modelRequestsPerMinute * a.meanOutputTokensPerCallIncludingReasoning;
const meanConcurrentModelRequests = modelRequestsPerSecond * a.meanModelRequestSeconds;
const synchronizedModelPeak = a.activePlanningTurns * Math.max(1, a.childConcurrencyPerTurn);
const workersForOneReplicaLoss = Math.ceil(a.activePlanningTurns / a.illustrativeWorkerSafeTurnSlots) + 1;
const connections = a.onlineUsers * a.devicesPerUser;
const pool = {
  api: a.apiReplicas * a.apiPoolMax,
  workerBusiness: workersForOneReplicaLoss * a.workerPoolMax,
  workerQueue: workersForOneReplicaLoss * a.queuePoolMaxPerWorker,
  pinnedListeners: (a.apiReplicas + workersForOneReplicaLoss) * a.notifyConnectionsPerProcess,
  operationsReserve: a.operationsConnectionsReserve
};
const round = value => Number(value.toFixed(3));
const output = {
  evidence: 'arithmetic_from_explicit_assumptions; not a benchmark or provider entitlement',
  assumptions: a,
  steadyState: {
    turnsPerSecond: round(turnsPerSecond), turnsPerMinute: round(turnsPerSecond * 60),
    modelRequestsPerMinute: round(modelRequestsPerMinute),
    meanConcurrentModelRequests: round(meanConcurrentModelRequests),
    synchronizedModelPeakAssumingParentReleasesSlotWhileWaiting: synchronizedModelPeak,
    inputTokensPerMinute, outputTokensPerMinute,
    headroomModelRequestsPerMinute: Math.ceil(modelRequestsPerMinute * factor),
    headroomMeanModelSlots: Math.ceil(meanConcurrentModelRequests * factor),
    headroomSynchronizedModelSlots: Math.ceil(synchronizedModelPeak * factor),
    headroomInputTokensPerMinute: Math.ceil(inputTokensPerMinute * factor),
    headroomOutputTokensPerMinute: Math.ceil(outputTokensPerMinute * factor)
  },
  oneBurstOf500: {
    modelCalls: a.activePlanningTurns * a.meanModelCallsPerTurn,
    inputTokens: a.activePlanningTurns * a.meanModelCallsPerTurn * a.meanInputTokensPerCall,
    outputTokens: a.activePlanningTurns * a.meanModelCallsPerTurn * a.meanOutputTokensPerCallIncludingReasoning
  },
  online: {
    clientConnections: connections,
    statusRpsAtTwoSecondPolling: connections / 2,
    statusRpsAtOneSecondPolling: connections,
    slowSafetyRefreshRpsAtThirtySeconds: round(connections / 30)
  },
  providerScenarios: a.providerCallsPerTurnScenarios.map(calls => ({
    networkCallsPerTurn: calls, steadyQps: round(turnsPerSecond * calls),
    headroomQps: round(turnsPerSecond * calls * factor)
  })),
  illustrativeDeploymentNotSizingEvidence: {
    workersForOneReplicaLoss,
    activeSlotsAfterOneWorkerLoss: (workersForOneReplicaLoss - 1) * a.illustrativeWorkerSafeTurnSlots,
    connectionBudgetParts: pool,
    connectionBudgetTotal: Object.values(pool).reduce((sum, value) => sum + value, 0)
  },
  sensitivity: {
    twiceTheMeanInputTokens: { inputTokensPerMinute: inputTokensPerMinute * 2 },
    fourTimesTheMeanInputTokens: { inputTokensPerMinute: inputTokensPerMinute * 4 },
    twiceTheTurnDurationWithSameArrivalRate: { activeTurnsNeeded: a.activePlanningTurns * 2 },
    threeParallelChildren: {
      synchronizedModelPeak: a.activePlanningTurns * 3,
      headroomModelSlots: Math.ceil(a.activePlanningTurns * 3 * factor)
    },
    retainedGiBPerHourIfSustained: round(turnsPerSecond * 3600 * a.meanRetainedBytesPerTurnExample / 1024 ** 3),
    retainedGiBPerDayIfSustained24Hours: round(turnsPerSecond * 86400 * a.meanRetainedBytesPerTurnExample / 1024 ** 3)
  }
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
