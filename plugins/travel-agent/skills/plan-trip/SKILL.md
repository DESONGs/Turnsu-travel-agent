---
name: plan-trip
description: Compare linked candidates, budget, routes, weather and per-traveler constraints, then explain a coherent schedule without committing it.
version: 2026-08-30
---

# Plan trip

Treat food, stay, transport and play as linked decisions. Compare only candidates supported by the supplied normalized evidence and deterministic route, budget and constraint results. You own preference-sensitive planning order; deterministic tools own route facts and arithmetic.

Automatically continue a complete planning request after research. A high-confidence semantic judgment can reorder a reversible draft only when its exact template and language are calibrated; it cannot waive constraints or create facts. Keep near-equivalent choices stable. Fetch obtainable evidence first; ask one necessary question with its impact only when the user owns the missing fact or must choose a material tradeoff. Continue the original plan when that answer arrives.

For itinerary planning, produce one primary `ItineraryPlan` from the current trip plan view. A second alternative is allowed only when it represents a material user-facing choice, such as bag drop before sightseeing versus immediate check-in and rest. Never create a new place in prose: every stop must reference a current candidate or selected `nodeId`, and every evidence reference must come from that candidate.

Set `scope=complete_trip` for a full plan or an adjustment to that full plan, including all retained stops. Adopting it replaces the selected set with the reviewed stops; changing dinner must retain lunch, and changing the hotel must not charge both hotels. Use `selected_visits` only when the user explicitly limits the work to routing particular stops. Previewing either scope never adopts it.

Plan in this order:

1. Preserve fixed arrival, reservation, lock and traveler-specific limits.
2. Decide Day, stop order, time window, duration and role from the user's priorities. `intercity_arrival`, `bag_drop`, `stay_check_in`, `stay_departure`, `stay_return`, `meal`, `activity` and `local_transport` are distinct roles. Do not assume check-in must precede all activities.
3. Prefer hard-constraint satisfaction before optimizing time, walking, transfers, estimated cost, weather exposure and local experience.
4. Give each stop a short rationale that explains the cross-domain choice. Do not put route minutes, prices, opening hours, facilities or accessibility claims in the rationale unless they already appear in supplied evidence.
5. Call `plan_itinerary_trial`. The tool checks real routes, chronology, trip dates, opening evidence, walking, transfers, stairs, fixed anchors, locks and freshness.

For a complete itinerary, cover the requested days and practical meal/rest windows between arrival and departure. Use distinct supported activities across days; do not repeat the same attraction merely to fill the schedule. A hotel may appear for bag drop, check-in and return. A self-arranged return is outside the requested planning scope. Reuse saved facts and candidates; ask about an exact arrival time only when no useful flexible draft is possible. State flexible timing as an assumption, never as a booked or verified arrival. If necessary user facts remain in `needsContext`, describe a conditional draft and name those gaps rather than claiming complete verification.

Choose the reversible draft on the user's behalf within their constraints; do not demand that they first choose one candidate in every domain. A soft preference (such as quieter or more indoor activities) is a ranking criterion, not a requirement to leave the rest of the day empty. When no candidate satisfies every preference, use the best supported alternative and explain the tradeoff without claiming unsupported quietness or facilities. Reusing a restaurant for different meals is allowed, but prefer variety when supported. Missing prices, future weather and final booking checks belong in assumptions; do not put these in `needsContext` as if the user must supply provider facts. Plan only the days the user asks you to arrange; an overnight stay with a self-arranged next-day return does not authorize a second sightseeing day.

For an “optimize the current route” request, plan only the stops in `currentOrder`; do not add a return journey, fill every empty day, or reopen candidate research. Put an item in `needsContext` only when the missing fact prevents these current stops from being routed or timed at all. Unknown prices, future-day gaps, booking policies and unselected return inventory are assumptions or follow-up notes, not blockers for the current route Trial.

If the first check returns `needs_repair`, repair exactly once using its `issueCode`, affected stops, observed facts and allowed repair directions. Keep the same run ID, use attempt 2, preserve unrelated fixed/locked stops, and change only what the issue justifies. Examples: shift a flexible stop later, move an optional activity to the next day, change a route mode, or reorder two flexible stops. Never retry with the same plan, start a new run, or remove a hard requirement to make the check pass.

Read the entire check before repairing. Budget overflow means compare cheaper sourced choices at the same budget first; it does not mean immediately ask to raise the budget. Missing mandatory accessibility evidence means inspect the named route/place evidence and available alternatives, and make at most one targeted research call if the source can provide that evidence. Changing a clock time or switching to a taxi cannot establish step-free continuity. If the source cannot verify it, preserve the partial draft, list the precise unverified parts and explain the next feasible action. Never ask the traveler to certify an unknown external fact or to waive a hard requirement simply to finish.

Each requested sightseeing day needs a meaningful supported activity plus practical meal coverage. Checking into a hotel early does not remove dinner. A day explicitly reserved for rest, self-arrangement or transfers can use `days[].purpose` with an exact quote from the user's request. Do not invent such an exception to bypass coverage. Preserve the separate number of sightseeing days and lodging nights.

A self-arranged return means do not research or book the return transport. It does not shorten the final sightseeing day to lunch. Unless the traveler has given an earlier departure boundary, offer the final afternoon as a flexible part of the draft (for example, activities ending around 17:00 with a stated timing assumption). Do not invent a booked departure. If quiet indoor candidates are insufficient, use the second permitted research to look specifically for other indoor choices before falling back to a sourced alternative with an explicit soft-preference tradeoff.

After a successful trial, you still own delivery: review the original objective, explain the actual daily choices and the main preference tradeoff, and distinguish sourced facts, estimates and future booking checks. Do not stop at saying a tool succeeded. After an unsuccessful trial, explain what has been saved and what remains; the draft is still visible but cannot be adopted until its blockers are resolved.

Use the actual `route.modes` in the checked result for transport claims, not a stop's `preferredModes`. If adopted route evidence was invalidated, retain its timeline for comparison without guessing its old transport mode. Party size comes from the current traveler facts, never from vehicle capacity. Keep run IDs, attempt numbers and internal validation fields out of the traveler-facing explanation.

If attempt 2 still fails, stop and return the blocker or `needs_context`. A failed or partial check is not an optimized itinerary. A successful Trial is still unconfirmed and must remain reversible until the user adopts it.

Check each named traveler separately. Keep mapped stairs, unknown step-free continuity and unknown elevator operation as different evidence states. Weather is a cross-domain constraint supplied by Runtime, never a fifth itinerary domain or a model-authored forecast.

Prefer a route or candidate only when the evidence supports the reason. Explain cost, time, walking, transfers, flexibility, source freshness and remaining unknowns. Preserve locks and unrelated decisions.

Outside a direct itinerary-planning turn, return schedule/fit findings, recommended and rejected candidate IDs, reason codes, needs-context items and evidence references. The Parent may use the result to build one proposal; this Skill and its child analysts never commit.

Never mutate Trip State or commit a patch.

References retained from the previous micro Skills:

- `../assess-traveler-operability/SKILL.md`
- `../assess-trip-weather/SKILL.md`
- `../evaluate-trip-fit/SKILL.md`
- `../shape-trip-schedule/SKILL.md`
- `../compare-trip-alternatives/SKILL.md`
- `../explain-trip-tradeoff/SKILL.md`
- `../review-trip-coherence/SKILL.md`
