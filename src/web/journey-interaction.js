// UI-only intent helpers. Trip writes still belong to the Parent Agent.
export function shouldSendComposerKey(event) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function nextTrialNodeId(selectedNodeId, clickedNodeId) {
  return selectedNodeId === clickedNodeId ? null : clickedNodeId;
}

// No route evidence is "unknown", never a zero-minute / zero-cost journey.
export function hasRouteMeasurements(mobility) {
  const legs = mobility?.legs ?? [];
  return legs.length > 0 && legs.every((leg) => {
    const selected = leg.alternatives?.find((item) => item.mode === leg.recommendedMode);
    return selected && Number.isFinite(selected.totalMinutes) && selected.totalMinutes >= 0;
  });
}

export function hasTripMapPoints(nodes, mobility) {
  const valid = (point) => Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude)
    && Math.abs(point.longitude) <= 180 && Math.abs(point.latitude) <= 90;
  return (nodes ?? []).some((node) => valid(node.location?.coordinates))
    || (mobility?.legs ?? []).some((leg) => valid(leg.origin?.coordinates) || valid(leg.destination?.coordinates));
}

// Once the server acknowledges a write, a failed read must never turn it into
// another write. Consumers present syncError as a read-only recovery action.
export async function runJourneyAction({ perform, onDelivered, synchronize }) {
  const receipt = await perform();
  try {
    onDelivered?.(receipt);
    await synchronize(receipt);
    return { receipt, syncError: null };
  } catch (syncError) {
    return { receipt, syncError };
  }
}
