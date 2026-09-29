import type {
  DecisionNode,
  MobilityObservation,
  ProviderResult,
  TransitSegment,
  TripBrief,
  TripCommitResult,
  PlaceVisitFeedbackSummary,
  TripFeedbackCategory,
  TripFeedbackVerdict,
  TripFeedbackVisibility,
  TripPatchProposal,
  TripProposalResult,
  TripQa,
  TripState,
  TripValidation,
  Traveler,
  TravelDomain,
  ResearchCriteriaInput,
  ItineraryPlan,
  TripFeasibility,
  TripItinerary,
} from "../contracts/index.js";

export interface CreateTripInput {
  tripId?: string;
  brief?: TripBrief;
  travelers?: Array<Partial<Traveler>>;
  ownerUserId?: string;
  memberUserIds?: string[];
}

export interface UpdateTripScopeServiceInput {
  tripId: string;
  brief?: Partial<TripBrief>;
  travelerCount?: number;
  travelerProfiles?: Array<Partial<Traveler>>;
  language?: string;
  foreignGuestRequired?: boolean;
}

export interface TripControlView {
  schemaVersion: "trip-control-view-v1";
  tripId: string;
  revision: number;
  storageVersion: number;
  activeBranchId: string;
  brief: TripBrief;
  travelers: Traveler[];
  openDecisions: TripState["openDecisions"];
  dirtySet: string[];
  taskQueues: TripState["taskQueues"];
  pendingProposals: Array<Omit<TripPatchProposal, "operations"> & { operationCount: number }>;
  weather: TripState["environment"]["weather"];
  mobility: TripState["environment"]["mobility"];
  providerStatus: "configured" | "provider_unavailable";
}

export interface TripPlanView {
  schemaVersion: "trip-plan-view-v1";
  tripId: string;
  revision: number;
  byDomain: Record<TravelDomain, TripPlanNode[]>;
  budget: TripQa["budget"];
  qa: TripQa;
  fulfillment: TripState["fulfillmentEvents"];
  pendingProposals: TripProposalView[];
  transitSegments: Array<{ nodeId: string; segment: TransitSegment }>;
  mapPreviewAvailable: boolean;
  weather: TripState["environment"]["weather"];
  mobility: TripState["environment"]["mobility"];
  itineraryTrial?: ItineraryPlanningTrial;
}

export type TripPlanNode = Pick<DecisionNode,
  | "nodeId" | "title" | "summary" | "selected" | "status" | "cost" | "time" | "location" | "lock"
  | "sourceStatus" | "foreignGuestEligible" | "spoilerLevel" | "media" | "sourceRefs" | "claimRefs" | "operability"
> & { visitFeedback?: PlaceVisitFeedbackSummary };

export type TripProposalCandidate = Pick<DecisionNode,
  | "nodeId" | "domain" | "title" | "summary" | "selected" | "cost" | "location" | "sourceStatus"
  | "foreignGuestEligible" | "spoilerLevel" | "media" | "sourceRefs" | "claimRefs" | "operability"
> & { visitFeedback?: PlaceVisitFeedbackSummary };

export interface TripProposalView {
  schemaVersion: "trip-proposal-view-v1";
  proposalId: string;
  baseRevision: number;
  title: string;
  summary: string;
  provider: string | null;
  providerLabel: string | null;
  checkedAt: string | null;
  sourceDocumentation: string | null;
  caveats: string[];
  partial: boolean;
  fixtureOnly: boolean;
  stagedAt: string | null;
  itineraryPlan?: ItineraryPlan | null;
  itineraryPreviewId?: string | null;
  planningRunId?: string | null;
  planningAttempt?: 1 | 2 | null;
  byDomain: Record<TravelDomain, TripProposalCandidate[]>;
}

export interface TripListView {
  schemaVersion: "trip-list-view-v1";
  storageMode: string;
  trips: Array<{
    tripId: string;
    revision: number;
    destination: string | null;
    dates: string | null;
    travelerCount: number;
    updatedAt: string;
    openDecisionCount: number;
    collaboration: { memberCount: number } | null;
  }>;
}

export interface OpenDecisionsView {
  schemaVersion: "open-decisions-v1";
  tripId: string;
  revision: number;
  decisions: TripState["openDecisions"];
  pendingProposals: TripPatchProposal[];
}

export interface TripMapAsset {
  contentType: string;
  body: Uint8Array;
}

export interface BookingHandoff {
  schemaVersion: "booking-handoff-v1";
  status: "ready";
  tripId: string;
  revision: number;
  nodeId: string;
  offerId: string;
  source: string;
  handoffUrl: string | null;
  totalPrice: number;
  currency: string;
  automaticPurchase: false;
  sensitiveDataHandled: false;
}

export interface ResearchTripOptionsInput {
  tripId: string;
  capability?: string;
  query?: string;
  question?: string;
  domains?: TravelDomain[];
  criteria?: ResearchCriteriaInput;
  signal?: AbortSignal;
}

export interface ItineraryPlanningTrial {
  schemaVersion: "itinerary-planning-trial-v1";
  status: "trial_ready" | "needs_repair" | "blocked" | "needs_context" | "stale_discarded" | "needs_recheck";
  runId: string;
  tripId?: string;
  baseRevision: number;
  attempt: 1 | 2;
  proposalId?: string;
  previewId?: string;
  itinerary?: TripItinerary | null;
  mobility?: MobilityObservation;
  feasibility?: TripFeasibility | null;
  committed: false;
  [key: string]: unknown;
}

export type ResearchTripOptionsResult =
  | { schemaVersion: "travel-research-proposal-result-v1"; status: "proposed"; tripId: string; revision: number; proposal: TripProposalView; fabricatedResults: false }
  | (ProviderResult & { tripId: string; revision: number })
  | TripProposalResult;

export interface TripMutationResult {
  schemaVersion: string;
  status: "committed" | "proposed" | "rejected" | "rejected_by_user" | "needs_rebase";
  tripId?: string;
  revision?: number;
  validation?: TripValidation;
  qa?: TripQa;
}

export type TravelMutationResult = TripMutationResult | TripCommitResult | TripProposalResult;

export interface TravelServicePort {
  createTrip(input?: CreateTripInput): Promise<TripControlView>;
  updateTripScope(input: UpdateTripScopeServiceInput): Promise<TripControlView>;
  listTrips(input?: { userId?: string }): Promise<TripListView>;
  getTripControlView(tripId: string): Promise<TripControlView>;
  getTripPlanView(tripId: string): Promise<TripPlanView>;
  renderTripMap(tripId: string): Promise<TripMapAsset>;
  previewTripMobility(input: { tripId: string; baseRevision?: number; selections?: Partial<Record<TravelDomain, string>>; previewId?: string; routeModes?: Record<string, "walk" | "transit" | "taxi"> }): Promise<{
    schemaVersion: "trip-mobility-preview-v1";
    status: MobilityObservation["status"] | "needs_refresh";
    tripId: string;
    revision: number;
    mobility?: MobilityObservation;
    fabricatedResults: false;
    [key: string]: unknown;
  }>;
  planItineraryTrial(input: { tripId: string; plan: ItineraryPlan; baselinePreviewId?: string | null; signal?: AbortSignal }): Promise<ItineraryPlanningTrial>;
  refreshTripMobility(input: { tripId: string }): Promise<{ schemaVersion: "trip-mobility-refresh-result-v1"; status: MobilityObservation["status"]; tripId: string; revision: number; mobility: MobilityObservation; qa: TripQa; fabricatedResults: false }>;
  getOpenDecisions(tripId: string): Promise<OpenDecisionsView>;
  researchTripOptions(input: ResearchTripOptionsInput): Promise<ResearchTripOptionsResult>;
  proposeTripChange(input: { tripId: string; proposal: TripPatchProposal }, actor?: string): Promise<TravelMutationResult>;
  acceptTripChange(input: { tripId: string; proposalId: string; selections?: Partial<Record<TravelDomain, string>>; partial?: boolean; previewId?: string; baseRevision?: number; routeModes?: Record<string, "walk" | "transit" | "taxi"> }): Promise<TravelMutationResult>;
  rejectTripChange(input: { tripId: string; proposalId: string }): Promise<TravelMutationResult>;
  discardItineraryTrial(input: { tripId: string; proposalId: string; baseRevision?: number }): Promise<{ schemaVersion: "itinerary-trial-discard-result-v1"; status: "discarded" | "unchanged" | "needs_rebase"; tripId: string; revision: number; storageVersion?: number }>;
  prepareBookingHandoff(input: { tripId: string; nodeId: string; offerId: string; explicitUserConfirmation: true }): Promise<BookingHandoff>;
  recordBookingConfirmation(input: { tripId: string; nodeId: string; offerId?: string; confirmationRef: string; baseRevision: number; explicitUserConfirmation: true }): Promise<TravelMutationResult>;
  reportTripDisruption(input: { tripId: string; proposal: TripPatchProposal }, actor?: string): Promise<TravelMutationResult>;
  submitTripFeedback(input: {
    tripId: string;
    baseRevision: number;
    category: TripFeedbackCategory;
    nodeId?: string;
    text: string;
    visibility?: TripFeedbackVisibility;
    verdict?: TripFeedbackVerdict;
    tags?: string[];
    spendCny?: number;
    waitMinutes?: number;
    visitDate?: string;
  }, actor?: string): Promise<TravelMutationResult>;
}

const REQUIRED_METHODS: ReadonlyArray<keyof TravelServicePort> = [
  "createTrip", "updateTripScope", "listTrips", "getTripControlView", "getTripPlanView", "renderTripMap", "previewTripMobility",
  "refreshTripMobility", "getOpenDecisions", "researchTripOptions", "proposeTripChange", "planItineraryTrial", "acceptTripChange",
  "rejectTripChange", "discardItineraryTrial", "prepareBookingHandoff", "recordBookingConfirmation", "reportTripDisruption", "submitTripFeedback",
];

export function assertTravelServicePort(value: unknown): TravelServicePort {
  if (!value || typeof value !== "object" || REQUIRED_METHODS.some((method) => typeof Reflect.get(value, method) !== "function")) {
    throw new Error("invalid_travel_service_port");
  }
  return value as TravelServicePort;
}
