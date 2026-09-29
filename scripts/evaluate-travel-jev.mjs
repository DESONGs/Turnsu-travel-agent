import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionRepository } from "../src/persistence/execution-repository.mjs";
import { parseTravelEnvFile } from "../src/http/runtime-env.mjs";
import { withTravelExecution } from "../travel-agent-pi-package/src/host/execution-context.ts";
import { buildJudgmentSnapshot, createTravelJudgment, JUDGMENT_TEMPLATE } from "../travel-agent-pi-package/src/host/travel-judgment.ts";
import { decisionHash, TravelExecutionDeferred } from "../travel-agent-pi-package/src/host/travel-decision-policy.ts";
import { travelJudgmentCases } from "../tests/fixtures/jev-travel-cases.mjs";

if (process.env.TRAVEL_JEV_LIVE_EVAL !== "true") throw new Error("live_evaluation_opt_in_required");
const supplied = process.env.TRAVEL_JEV_TEST_ENV_FILE ? parseTravelEnvFile(await readFile(process.env.TRAVEL_JEV_TEST_ENV_FILE, "utf8")) : {};
const key = process.env.TYPESAFE_API_KEY ?? supplied.TYPESAFE_API_KEY;
if (!key) throw new Error("jev_not_configured");
const root = await mkdtemp(join(tmpdir(), "travel-jev-eval-"));
const repository = new ExecutionRepository({ filename: join(root, "eval.sqlite") });
const rows = [];
const datasetHash = decisionHash(travelJudgmentCases);
const judgment = createTravelJudgment({ TYPESAFE_API_KEY: key, TRAVEL_AGENT_JEV_MODE: "shadow" });
try {
  for (const example of travelJudgmentCases) {
    await repository.submit({ conversationId: example.id, userId: "synthetic_evaluation", requestId: example.id, requestHash: datasetHash, input: { text: example.objective } });
    const run = await repository.claim({ workerId: "evaluation", leaseMs: 120000, globalLimit: 1, perUserLimit: 1 });
    const context = { ...run, signal: AbortSignal.timeout(30000), assertCurrent: () => repository.assertCurrent(run), emit: event => repository.event(run, event),
      reserveJudgment: async (tokens, retry) => { const permit = await repository.reserveJudgment(run, { reservedTokens: tokens, retry }); if (!permit.callId) throw new TravelExecutionDeferred(permit.notBefore, permit.waitReason); return usage => repository.finishModel(permit.callId, usage); },
      cooldownJudgment: until => repository.cooldownJudgment(until) };
    const snapshot = buildJudgmentSnapshot({ ownerId: "synthetic_evaluation", tripId: `trip_${example.id}`, baseRevision: 1, criteriaFingerprint: datasetHash, objective: example.objective, brief: { destination: "上海" },
      providerResult: { byDomain: { stay: example.evidence.map((summary, index) => ({ candidateId: `candidate_${index}`, title: `选项${index + 1}`, summary, sourceId: `source_${index}` })) } } });
    const began = performance.now();
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { result = await withTravelExecution(context, () => judgment.evaluate(snapshot)); break; }
      catch (error) { if (!(error instanceof TravelExecutionDeferred) || attempt) throw error; await delay(Math.min(30000, Math.max(1, error.notBefore - Date.now()))); }
    }
    const actual = result.judgments.map(item => item.support);
    rows.push({ id: example.id, status: result.status, code: result.code ?? null, elapsedMs: Math.round(performance.now() - began), expectedScope: example.scope, scope: result.scope, scopeCorrect: example.scope === result.scope,
      expected: example.expected, actual, supportCorrect: example.expected ? example.expected.every((label, i) => label === actual[i]) : null,
      judgments: result.judgments.map(({ candidateId, support, confidence, fit }) => ({ candidateId, support, confidence, fit })) });
    await repository.finish(run, "completed", { status: "completed" });
    process.stdout.write(`${example.id}: ${result.status}, scope=${result.scope}\n`);
    await delay(300);
  }
  const usage = (await repository.query("SELECT COUNT(*) AS calls,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens FROM travel_model_calls")).rows[0];
  const output = { testedAt: new Date().toISOString(), model: "jev-1.13.0", template: JUDGMENT_TEMPLATE, datasetHash, evidenceScope: "Real Jev over pre-labeled fictional Chinese travel evidence. Not a live travel Provider test, product A/B or 500-user acceptance.",
    automaticRollout: "disabled_pending_independent_validation", scopePassed: rows.filter(row => row.scopeCorrect).length, scopeTotal: rows.length,
    supportCasesPassed: rows.filter(row => row.supportCorrect === true).length, supportCasesTotal: rows.filter(row => row.expected).length, usage, rows };
  const path = resolve(process.env.TRAVEL_JEV_EVAL_OUTPUT ?? "/tmp/travel-jev-evaluation.json");
  await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: path, scopePassed: output.scopePassed, scopeTotal: output.scopeTotal, supportCasesPassed: output.supportCasesPassed, supportCasesTotal: output.supportCasesTotal, usage })}\n`);
  if (rows.some(row => row.status !== "evaluated" || !row.scopeCorrect || row.supportCorrect === false)) process.exitCode = 1;
} finally { await repository.close(); await rm(root, { recursive: true, force: true }); }
