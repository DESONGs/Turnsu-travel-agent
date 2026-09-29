/** Explicit contract fixture. It makes no claim about real travel sources or Jev quality. */
export function candidateFixture(domain, index, checkedAt = new Date().toISOString()) {
  const candidateId = `${domain}_${index}`;
  const sourceId = `source_${candidateId}`, entityId = `entity_${candidateId}`, claimId = `claim_${candidateId}`;
  return { candidateId, domain, title: `${domain} option ${index}`, summary: `有来源的${domain}资料 ${index}`, cost: 100, checkedAt,
    location: { name: `${domain} option ${index}`, address: "上海" }, media: [], operability: { provider: "decision_fixture" }, sourceId, entityId, claimId,
    source: { sourceId, provider: "decision_fixture", sourceType: "fixture", providerPoiId: candidateId, checkedAt, documentationUrl: "https://example.com/fixture", independenceGroup: sourceId, commercialBias: "fixture" },
    entity: { entityId, kind: domain, canonicalName: candidateId, providerRefs: [candidateId] },
    claim: { claimId, entityId, kind: "fixture_fact", statement: `fixture evidence ${candidateId}`, sourceRefs: [sourceId], sourceIndependence: "fixture", commercialBias: "fixture", confidence: .9, observedAt: checkedAt } };
}
export function researchFixture() {
  return { schemaVersion: "travel-provider-result-v1", status: "completed", provider: "decision_fixture", providerLabel: "Explicit decision fixture", destination: "上海", checkedAt: new Date().toISOString(),
    byDomain: Object.fromEntries(["play", "food", "stay", "transport"].map(domain => [domain, Array.from({ length: 3 }, (_, i) => candidateFixture(domain, i))])), partial: false, errors: [], caveats: [], fabricatedResults: false, fixtureOnly: true };
}
export function judgmentResponse(body, { support = "supported", scope = "compare" } = {}) {
  return { model: "jev-1.13.0", answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
    if (question.type === "score") return [key, { type: "score", score: 3, confidence: .99, legend: Object.fromEntries(question.criteria.map((v, i) => [i, v])), probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } }];
    const choice = key === "scope" ? scope : support;
    return [key, { type: "choice", choice, confidence: .99, probabilities: Object.fromEntries(Object.keys(question.criteria).map(k => [k, k === choice ? 1 : 0])) }];
  })), usage: { input_tokens: 100, output_tokens: 20 } };
}
