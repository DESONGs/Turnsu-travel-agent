export function parseOutput(text, allowedEvidence) {
  if (typeof text !== "string" || text.length > 16000) throw new Error("model_output_invalid");
  let result;
  try { result = JSON.parse(text); } catch { throw new Error("model_output_invalid"); }
  if (!result || Array.isArray(result) || typeof result !== "object"
    || Object.keys(result).sort().join(",") !== (result.kind === "itinerary_proposal" ? "evidenceIds,kind,stops,summary,unknowns" : "evidenceIds,kind,summary,unknowns")
    || !["suggestion", "needs_context", "itinerary_proposal"].includes(result.kind)
    || typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 4000
    || !Array.isArray(result.evidenceIds) || result.evidenceIds.length > 20
    || result.evidenceIds.some(id => typeof id !== "string" || !allowedEvidence.has(id))
    || !Array.isArray(result.unknowns) || result.unknowns.length > 20
    || result.unknowns.some(value => typeof value !== "string" || value.length > 400)
    || (result.kind !== "needs_context" && result.evidenceIds.length === 0)) throw new Error("model_output_invalid");
  if (result.kind === "itinerary_proposal") {
    const ids = new Set();
    const fields = ["stopId", "sourceResultId", "sourceId", "role", "startLocal", "timeZone", "utcOffset", "durationMinutes"];
    if (!Array.isArray(result.stops) || result.stops.length < 1 || result.stops.length > 128 || result.stops.some(stop =>
      !stop || typeof stop !== "object" || Object.keys(stop).some(key => !fields.includes(key))
      || !["stopId", "sourceResultId", "sourceId", "role", "startLocal", "timeZone"].every(key => typeof stop[key] === "string" && stop[key].length > 0 && stop[key].length <= 128)
      || !result.evidenceIds.includes(stop.sourceResultId) || !Number.isInteger(stop.durationMinutes) || stop.durationMinutes < 0 || stop.durationMinutes > 720
      || ids.has(stop.stopId) || !ids.add(stop.stopId))) throw new Error("model_output_invalid");
  }
  return result;
}
