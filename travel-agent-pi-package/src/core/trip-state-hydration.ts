import { FOUR_DOMAINS, assertTripState, assertSchema, TripStateSchema, type TripState } from "../contracts/index.js";
import { estimateTripBudget, normalizeTravelPrice } from "../runtime/trip-runtime-implementation.js";
import { ensureContinuousPlanning, projectAdoptedPlan } from "./continuous-planning.js";

type UnknownObject = { [key: string]: unknown };

function objectValue(value: unknown): UnknownObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownObject : null;
}

function optionalObject(value: unknown): UnknownObject {
  if (value === undefined) return {};
  const object = objectValue(value);
  if (!object) throw new Error("invalid_stored_trip");
  return object;
}

function optionalArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid_stored_trip");
  return value;
}

/**
 * Rehydrates fields added after the first persisted trip-control-state-v1 release.
 * It never infers traveler preferences or accepted decisions; only deterministic
 * display/default containers are added before strict schema validation.
 */
export function hydrateStoredTripState(value: unknown): TripState {
  const source = objectValue(value);
  if (!source || source.schemaVersion !== "trip-control-state-v1") throw new Error("invalid_stored_trip");
  const next = structuredClone(source);

  const brief = optionalObject(next.brief);
  next.brief = brief;

  next.travelers = optionalArray(next.travelers).map((travelerValue, index) => {
    const traveler = optionalObject(travelerValue);
    return {
      ...traveler,
      travelerId: traveler.travelerId ?? `traveler_${index + 1}`,
      displayName: traveler.displayName ?? `同行人 ${index + 1}`,
      relationship: traveler.relationship ?? null,
      role: traveler.role ?? "traveler",
      language: traveler.language ?? "zh-CN",
      hardConstraints: optionalArray(traveler.hardConstraints),
      softPreferences: optionalArray(traveler.softPreferences),
      careNeeds: optionalObject(traveler.careNeeds),
      operability: optionalObject(traveler.operability),
    };
  });

  next.nodes = optionalArray(next.nodes).map((nodeValue) => {
    const node = optionalObject(nodeValue);
    const price = normalizeTravelPrice(node.price ?? node.cost, {
      currency: optionalObject(next.brief).currency ?? "CNY",
      checkedAt: optionalObject(node.operability).checkedAt ?? node.updatedAt ?? null,
    });
    return { ...node, media: optionalArray(node.media), price, cost: price.amount ?? 0 };
  });
  next.edges = optionalArray(next.edges);
  next.dirtySet = optionalArray(next.dirtySet);
  next.openDecisions = optionalArray(next.openDecisions);
  next.pendingProposals = optionalArray(next.pendingProposals).map((proposalValue) => {
    const proposal = optionalObject(proposalValue);
    const operations = optionalArray(proposal.operations).map((operationValue) => {
      const operation = optionalObject(operationValue);
      if (operation.kind !== "add_candidate") return operation;
      const node = optionalObject(operation.node);
      const price = normalizeTravelPrice(node.price ?? node.cost, {
        currency: optionalObject(next.brief).currency ?? "CNY",
        checkedAt: optionalObject(node.operability).checkedAt ?? null,
      });
      return { ...operation, node: { ...node, price, cost: price.amount ?? 0 } };
    });
    return { ...proposal, operations };
  });
  next.proposalHistory = optionalArray(next.proposalHistory);
  next.feedbackLedger = optionalArray(next.feedbackLedger);
  next.fulfillmentLedger = optionalArray(next.fulfillmentLedger);
  next.fulfillmentEvents = optionalArray(next.fulfillmentEvents);
  next.changeJournal = optionalArray(next.changeJournal);

  const queues = optionalObject(next.taskQueues);
  next.taskQueues = Object.fromEntries(FOUR_DOMAINS.map((domain) => [domain, optionalArray(queues[domain])]));
  const evidence = optionalObject(next.evidence);
  next.evidence = {
    contentItems: optionalArray(evidence.contentItems),
    claims: optionalArray(evidence.claims),
    entities: optionalArray(evidence.entities),
  };
  const environment = optionalObject(next.environment);
  const mobility = environment.mobility == null ? null : optionalObject(environment.mobility);
  const mobilityCoverage = mobility ? optionalObject(mobility.coverage) : {};
  next.environment = {
    ...environment,
    weather: environment.weather ?? null,
    mobility: mobility ? {
      ...mobility,
      coverage: {
        ...mobilityCoverage,
        routedNodeIds: optionalArray(mobilityCoverage.routedNodeIds),
        unresolvedNodeIds: optionalArray(mobilityCoverage.unresolvedNodeIds),
        routedStopIds: optionalArray(mobilityCoverage.routedStopIds),
        unresolvedStopIds: optionalArray(mobilityCoverage.unresolvedStopIds),
        unscheduled: mobilityCoverage.unscheduled !== false,
      },
      itinerary: mobility.itinerary ?? null,
      feasibility: mobility.feasibility ?? null,
    } : null,
    updatedAt: environment.updatedAt ?? null,
  };
  const readiness = optionalObject(next.readiness);
  const readinessSignals = optionalObject(readiness.signals);
  next.readiness = {
    schemaVersion: "trip-readiness-state-v1",
    version: Number.isInteger(readiness.version) && Number(readiness.version) >= 0 ? readiness.version : 0,
    signals: {
      travel_documents: readinessSignals.travel_documents ?? "unknown",
      mobile_access: readinessSignals.mobile_access ?? "unknown",
      cashless_access: readinessSignals.cashless_access ?? "unknown",
      china_account_continuity: readinessSignals.china_account_continuity ?? "unknown",
    },
    updatedAt: readiness.updatedAt ?? null,
  };
  next.budgetLedger = estimateTripBudget(next);
  const state = assertTripState(next);
  ensureContinuousPlanning(state);
  projectAdoptedPlan(state);
  state.budgetLedger = assertSchema(TripStateSchema.properties.budgetLedger, estimateTripBudget(state), "invalid_trip_budget");
  return assertTripState(state);
}
