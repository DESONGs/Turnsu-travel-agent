import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type, type Static, type TSchema } from "typebox";
import { createTravelService } from "../../src/api/create-travel-service.mjs";
import { travelHttpToolsFromEnv, TRAVEL_HOST_TOOLS, TRAVEL_HOST_CONFIRMATION_TOOLS, type TravelHttpTools } from "../src/host/travel-http-tools.js";
import { ItineraryPlanSchema, ResearchCriteriaInputSchema, TripBriefSchema, TripPatchProposalSchema, TravelerSchema } from "../src/contracts/index.js";
import { loadTravelSkill } from "../../src/agent/travel-skill-loader.mjs";

// Itinerary proof is produced by plan_itinerary_trial, not authored through
// generic candidate/disruption proposals. Reuse the remaining canonical fields.
const candidateProposalParameters = Type.Omit(TripPatchProposalSchema, ["itineraryPlan", "itineraryPreviewId", "planningRunId", "planningAttempt", "requireCompletePlan", "planningUserRequest"]);

const travelerProfileParameters = Type.Object({
  travelerId: Type.Optional(Type.String()),
  displayName: Type.String({ minLength: 1, maxLength: 40 }),
  relationship: Type.Optional(Type.String({ maxLength: 40 })),
  language: Type.Optional(Type.String({ maxLength: 24 })),
  careNeeds: Type.Optional(Type.Object({
    mobility: Type.Optional(Type.Object({
      reduceWalking: Type.Optional(Type.Boolean()),
      maxContinuousWalkMeters: Type.Optional(Type.Integer({ minimum: 50, maximum: 20_000 })),
      maxTransfers: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
      avoidStairs: Type.Optional(Type.Boolean()),
      stepFreeRequired: Type.Optional(Type.Boolean()),
      wheelchairSpaceRequired: Type.Optional(Type.Boolean()),
      luggageAssistanceRequired: Type.Optional(Type.Boolean()),
    })),
    stamina: Type.Optional(Type.Object({
      needsFrequentRest: Type.Optional(Type.Boolean()),
      restEveryMinutes: Type.Optional(Type.Integer({ minimum: 10, maximum: 240 })),
      maxActiveMinutesPerBlock: Type.Optional(Type.Integer({ minimum: 20, maximum: 720 })),
    })),
    schedule: Type.Optional(Type.Object({ earliestStartTime: Type.Optional(Type.String()), latestReturnTime: Type.Optional(Type.String()), latestDinnerTime: Type.Optional(Type.String()), regularMealTimes: Type.Optional(Type.Boolean()) })),
    facilities: Type.Optional(Type.Object({ accessibleToiletRequired: Type.Optional(Type.Boolean()), toiletAccessPriority: Type.Optional(Type.Boolean()), nursingRoomRequired: Type.Optional(Type.Boolean()), strollerFriendlyRequired: Type.Optional(Type.Boolean()), quietRetreatRequired: Type.Optional(Type.Boolean()) })),
    sensory: Type.Optional(Type.Object({ avoidCrowds: Type.Optional(Type.Boolean()), avoidStrongSensoryStimuli: Type.Optional(Type.Boolean()) })),
    food: Type.Optional(Type.Object({ exclusions: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 12 })) })),
  })),
});

function statusOf(details: unknown): unknown {
  return details && typeof details === "object" ? Reflect.get(details, "status") : undefined;
}

function response(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
    isError: ["error", "rejected", "needs_rebase", "cancelled"].includes(String(statusOf(details))),
  };
}

function errorField(error: unknown, field: string): unknown {
  return error && typeof error === "object" ? Reflect.get(error, field) : undefined;
}

type ToolConfig<Parameters extends TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: Parameters;
  run: (params: Static<Parameters>) => Promise<unknown>;
};

function register<const Parameters extends TSchema>(pi: ExtensionAPI, config: ToolConfig<Parameters>, host?: TravelHttpTools) {
  pi.registerTool({
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,
    async execute(_id, params, signal, _update, context) {
      try {
        signal?.throwIfAborted();
        if (host && TRAVEL_HOST_CONFIRMATION_TOOLS.has(config.name)) {
          if (!context.hasUI) return response({ status: "rejected", code: "explicit_user_confirmation_required" });
          const confirmed = await context.ui.confirm("确认旅行操作", `${config.label}\n${JSON.stringify(params, null, 2)}`, signal ? { signal } : undefined);
          if (!confirmed) return response({ status: "rejected", code: "user_declined" });
          signal?.throwIfAborted();
        }
        return response(host ? await host.invoke(config.name, params, signal) : await config.run(params));
      } catch (error: unknown) {
        return response({ status: "error", code: errorField(error, "code") ?? "internal_error", details: errorField(error, "details") ?? null });
      }
    },
  });
}

export function registerTravelBusinessRuntime(pi: ExtensionAPI, { service, host }: {
  service?: ReturnType<typeof createTravelService>; host?: TravelHttpTools;
} = {}) {
  // Laziness is important: API hosts must never construct a second local TripStore.
  const getService = () => service ??= createTravelService(process.env);
  const registerTool = <const Parameters extends TSchema>(config: ToolConfig<Parameters>) => register(pi, config, host);
  registerTool({
    name: "create_trip", label: "Create Trip", description: "Create the persistent shared state for one complete Travel V1 trip.",
    parameters: Type.Object({ tripId: Type.Optional(Type.String()), brief: Type.Optional(TripBriefSchema), travelers: Type.Optional(Type.Array(Type.Partial(TravelerSchema))) }),
    run: (params) => getService().createTrip(params),
  });
  registerTool({
    name: "update_trip_scope", label: "Update Trip Scope", description: "Save newly understood traveler facts without inferring them from keywords or overwriting omitted facts.",
    parameters: Type.Object({
      tripId: Type.String(),
      brief: Type.Optional(Type.Partial(TripBriefSchema)),
      travelerCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      language: Type.Optional(Type.String()),
      foreignGuestRequired: Type.Optional(Type.Boolean()),
      travelerProfiles: Type.Optional(Type.Array(travelerProfileParameters, { maxItems: 12 })),
    }),
    run: (params) => getService().updateTripScope(params),
  });
  registerTool({
    name: "get_trip_control_view", label: "Get Trip Control View", description: "Read trip revision, open decisions, dirty set, queues, and pending proposals.",
    parameters: Type.Object({ tripId: Type.String() }), run: ({ tripId }) => getService().getTripControlView(tripId),
  });
  registerTool({
    name: "get_trip_plan_view", label: "Get Trip Plan View", description: "Read the linked food, stay, transport, and play plan with QA.",
    parameters: Type.Object({ tripId: Type.String() }), run: ({ tripId }) => getService().getTripPlanView(tripId),
  });
  registerTool({
    name: "get_open_decisions", label: "Get Open Decisions", description: "Read unresolved decisions and staged proposals.",
    parameters: Type.Object({ tripId: Type.String() }), run: ({ tripId }) => getService().getOpenDecisions(tripId),
  });
  registerTool({
    name: "research_trip_options", label: "Research Trip Options", description: "Request provider-backed research; reports provider_unavailable until an audited provider is enabled.",
    parameters: Type.Object({
      tripId: Type.String(),
      capability: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      question: Type.Optional(Type.String({ maxLength: 800 })),
      domains: Type.Optional(Type.Array(Type.Union([Type.Literal("play"), Type.Literal("food"), Type.Literal("stay"), Type.Literal("transport")]), { minItems: 1, maxItems: 4 })),
      criteria: Type.Optional(ResearchCriteriaInputSchema),
    }),
    run: (params) => getService().researchTripOptions(params),
  });
  registerTool({
    name: "propose_trip_change", label: "Propose Trip Change", description: "Stage a revisioned TripPatchProposal without changing the accepted plan.",
    parameters: Type.Object({ tripId: Type.String(), proposal: candidateProposalParameters }), run: (params) => getService().proposeTripChange(params),
  });
  registerTool({
    name: "plan_itinerary_trial", label: "Plan Itinerary Trial", description: "Check one model-authored itinerary against real routes and constraints; at most one repair attempt and no state commit.",
    parameters: Type.Object({ tripId: Type.String(), plan: ItineraryPlanSchema }), run: (params) => getService().planItineraryTrial(params),
  });
  registerTool({
    name: "accept_trip_change", label: "Accept Trip Change", description: "Parent-only atomic commit of one staged proposal.",
    parameters: Type.Object({
      tripId: Type.String(),
      proposalId: Type.String(),
      selections: Type.Optional(Type.Object({
        play: Type.Optional(Type.String()), food: Type.Optional(Type.String()), stay: Type.Optional(Type.String()), transport: Type.Optional(Type.String()),
      }, { additionalProperties: false })),
      partial: Type.Optional(Type.Boolean()),
      previewId: Type.Optional(Type.String({ maxLength: 128 })),
      baseRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      routeModes: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Literal("walk"), Type.Literal("transit"), Type.Literal("taxi")]))),
    }), run: (params) => getService().acceptTripChange(params),
  });
  registerTool({
    name: "reject_trip_change", label: "Reject Trip Change", description: "Reject one staged proposal without changing the accepted plan.",
    parameters: Type.Object({ tripId: Type.String(), proposalId: Type.String() }), run: (params) => getService().rejectTripChange(params),
  });
  registerTool({
    name: "prepare_booking_handoff", label: "Prepare Booking Handoff", description: "Prepare an external handoff for a selected fresh offer; never purchases.",
    parameters: Type.Object({ tripId: Type.String(), nodeId: Type.String(), offerId: Type.String(), explicitUserConfirmation: Type.Boolean() }),
    run: (params) => getService().prepareBookingHandoff(params),
  });
  registerTool({
    name: "record_booking_confirmation", label: "Record Booking Confirmation", description: "Record a user-provided external confirmation and lock its decision.",
    parameters: Type.Object({ tripId: Type.String(), nodeId: Type.String(), offerId: Type.Optional(Type.String()), confirmationRef: Type.String(), baseRevision: Type.Integer(), explicitUserConfirmation: Type.Boolean() }),
    run: (params) => getService().recordBookingConfirmation(params),
  });
  registerTool({
    name: "report_trip_disruption", label: "Report Trip Disruption", description: "Stage a bounded disruption patch for the affected neighborhood.",
    parameters: Type.Object({ tripId: Type.String(), proposal: candidateProposalParameters }), run: (params) => getService().reportTripDisruption(params),
  });
  registerTool({
    name: "submit_trip_feedback", label: "Submit Trip Feedback", description: "Record trip-linked visit feedback; shared structured experience remains non-authoritative user evidence.",
    parameters: Type.Object({
      tripId: Type.String(),
      baseRevision: Type.Integer(),
      category: Type.Union([Type.Literal("personal_experience"), Type.Literal("preference_change"), Type.Literal("fact_correction"), Type.Literal("unverified_public_info")]),
      nodeId: Type.Optional(Type.String()),
      text: Type.String({ minLength: 1, maxLength: 2000 }),
      visibility: Type.Optional(Type.Union([Type.Literal("trip_only"), Type.Literal("anonymous_travelers")])),
      verdict: Type.Optional(Type.Union([Type.Literal("recommend"), Type.Literal("mixed"), Type.Literal("not_recommend")])),
      tags: Type.Optional(Type.Array(Type.Union([Type.Literal("local_character"), Type.Literal("worth_detour"), Type.Literal("easy_to_reach"), Type.Literal("low_queue"), Type.Literal("helpful_service"), Type.Literal("family_friendly"), Type.Literal("quiet_rest"), Type.Literal("accurate_listing"), Type.Literal("useful_facilities"), Type.Literal("foreigner_friendly"), Type.Literal("good_value"), Type.Literal("comfortable_pace")]), { maxItems: 8 })),
      spendCny: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
      waitMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_440 })),
      visitDate: Type.Optional(Type.String({ pattern: "^20\\d{2}-\\d{2}-\\d{2}$" })),
    }),
    run: (params) => getService().submitTripFeedback(params),
  });
}

export default function (pi: ExtensionAPI) {
  const host = travelHttpToolsFromEnv(process.env);
  registerTravelBusinessRuntime(pi, host ? { host } : {});
  if (host) {
    const allowed = new Set<string>([...TRAVEL_HOST_TOOLS, "travel_read_skill"]);
    let calls = 0;
    let plans = 0;
    let research = 0;
    let runId = "";
    pi.on("before_agent_start", async (event) => {
      calls = 0; plans = 0; research = 0; runId = `hostplan_${randomUUID()}`;
      return { systemPrompt: `${event.systemPrompt}\nThis API host uses create_trip then update_trip_scope for save_trip_understanding. Use travel_read_skill for the installed Skills; no shell or general filesystem tool is available. Read current control and plan views before continuing a historical trip. Research delegates bounded Child analysis to the shared TravelService. Plan runId for this turn: ${runId}; at most attempt 1 and one repair attempt 2. Never claim confirmation until the confirmation dialog is accepted and the API returns committed. Images must use the request-only Web path.` };
    });
    pi.on("tool_call", async (event, context) => {
      if (!allowed.has(event.toolName)) return { block: true, reason: "travel_host_tool_not_allowed" };
      if (++calls > 12 || (event.toolName === "research_trip_options" && ++research > 2)) {
        await context.abort();
        return { block: true, reason: "travel_host_tool_budget_exhausted" };
      }
      if (event.toolName === "plan_itinerary_trial") {
        const plan = event.input["plan"];
        if (++plans > 2 || !plan || typeof plan !== "object" || Reflect.get(plan, "runId") !== runId || Reflect.get(plan, "attempt") !== plans) {
          return { block: true, reason: "itinerary_planning_run_identity_mismatch" };
        }
      }
      return undefined;
    });
    pi.registerTool({
      name: "travel_read_skill", label: "Read Travel Skill",
      description: "Read one installed Travel Skill by name. No arbitrary file access is available.",
      parameters: Type.Object({ skillId: Type.Union([Type.Literal("understand-trip"), Type.Literal("research-trip"), Type.Literal("plan-trip"), Type.Literal("recover-trip")]) }),
      async execute(_id, { skillId }) { return response(loadTravelSkill(skillId)); },
    });
  }
}
