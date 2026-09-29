import assert from "node:assert/strict";
import test from "node:test";
import { AmapTravelResearchProvider } from "../src/providers/amap-travel-research.mjs";
import { normalizeTripMobility } from "../travel-agent-pi-package/src/contracts/public.ts";

const point = (longitude, latitude) => ({ longitude, latitude, coordinateSystem: "GCJ-02" });

test("AMap checks the last visit of a multi-day itinerary as well as the first eight routes", async () => {
  const routeCalls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v3/geocode/geo") return new Response(JSON.stringify({ status: "1", infocode: "10000", geocodes: [{ citycode: "021", adcode: "310000", location: "121.47,31.23" }] }));
    routeCalls.push(parsed);
    if (parsed.pathname.includes("transit")) return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [] } }));
    return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "1000", cost: { duration: "600", taxi: "18" }, steps: [] }] } }));
  };
  const selectedNodes = Array.from({ length: 17 }, (_, index) => ({ nodeId: `place_${index}`, domain: "play", title: `测试地点 ${index}`, selected: true, location: { citycode: "021", coordinates: point(121.47 + index * 0.001, 31.23) } }));
  const itineraryStops = [...selectedNodes, selectedNodes[0]].map((node, index) => ({ nodeId: node.nodeId, stopId: `visit_${index}`, title: node.title, role: "activity", dayIndex: Math.floor(index / 6) + 1, date: `2026-10-${15 + Math.floor(index / 6)}`, startAt: `2026-10-${15 + Math.floor(index / 6)}T${String(8 + index % 6 * 2).padStart(2, "0")}:00:00+08:00` }));
  const provider = new AmapTravelResearchProvider({ apiKey: "test-key", fetchImpl, requestIntervalMs: 0, rateLimitRetryMs: 0 });
  const result = normalizeTripMobility(await provider.planMobility({ brief: { destination: "上海" }, selectedNodes, itineraryStops }));
  assert.equal(result.status, "completed");
  assert.equal(result.legs.length, 17);
  assert.equal(result.legs.at(-1).origin.nodeId, "place_16");
  assert.equal(result.legs.at(-1).destination.stopId, "visit_17");
  assert.deepEqual(result.coverage.unresolvedStopIds, []);
  assert.equal(result.coverage.routedStopIds.length, 18);
  assert.equal(routeCalls.filter(call => call.pathname.includes("driving")).length, 17);
});

test("AMap mobility turns selected places into bounded walking, transit and taxi alternatives without claiming real-time arrival", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname === "/v3/geocode/geo") {
      return new Response(JSON.stringify({ status: "1", infocode: "10000", geocodes: [{ citycode: "021", adcode: "310000", location: "121.473701,31.230416" }] }), { headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/v5/direction/transit/integrated") {
      return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ distance: "6200", walking_distance: "620", cost: { duration: "2100", transit_fee: "4" }, segments: [{ walking: { steps: [{ instruction: "乘直梯后步行至人民广场站", distance: "420", duration: "360", navi: { walk_type: "9" }, polyline: "121.473701,31.230416;121.474000,31.231000" }] }, bus: { buslines: [{ name: "地铁2号线(浦东国际机场方向)", departure_stop: { name: "人民广场" }, arrival_stop: { name: "陆家嘴" }, duration: "720", distance: "4800", polyline: "121.474000,31.231000;121.499809,31.239666" }] } }] }] } }), { headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/v5/direction/driving") {
      return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "7000", cost: { duration: "1500", taxi: "35" }, steps: [{ instruction: "沿延安东路行驶", step_distance: "7000", cost: { duration: "1500" }, polyline: "121.473701,31.230416;121.499809,31.239666" }] }] } }), { headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/v5/direction/walking") {
      return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "7400", cost: { duration: "5400" }, steps: [{ instruction: "步行前往", step_distance: "7400", cost: { duration: "5400" }, polyline: "121.473701,31.230416;121.499809,31.239666" }] }] } }), { headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/v3/staticmap") {
      assert.match(parsed.searchParams.get("paths"), /^8,0x216DD7/);
      return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    }
    throw new Error(`unexpected path ${parsed.pathname}`);
  };
  const provider = new AmapTravelResearchProvider({ apiKey: "test-key", fetchImpl, requestIntervalMs: 0, rateLimitRetryMs: 0, clock: () => new Date("2026-08-16T08:00:00.000Z") });
  const mobility = normalizeTripMobility(await provider.planMobility({
    brief: { destination: "上海", dates: "2026-10-03 至 2026-10-07" },
    travelers: [{ travelerId: "traveler_father", displayName: "父亲", careNeeds: { mobility: { maxContinuousWalkMeters: 800, maxTransfers: 1, avoidStairs: true } } }],
    targetAreas: ["人民广场"],
    selectedNodes: [
      { nodeId: "stay_people_square", domain: "stay", title: "人民广场酒店", selected: true, location: { citycode: "021", coordinates: { longitude: 121.473701, latitude: 31.230416 } }, operability: { providerPoiId: "stay-1" } },
      { nodeId: "play_pearl", domain: "play", title: "东方明珠", selected: true, location: { citycode: "021", coordinates: { longitude: 121.499809, latitude: 31.239666 } }, operability: { providerPoiId: "play-1" } },
    ],
  }));

  assert.equal(mobility.status, "completed");
  assert.equal(mobility.legs.length, 2, "a dated activity route should include the return to the stay anchor");
  assert.equal(mobility.legs.at(-1).destination.nodeId, "stay_people_square");
  assert.equal(mobility.legs[0].recommendedMode, "transit");
  assert.deepEqual(mobility.travelerFit.constrainedTravelerIds, ["traveler_father"]);
  assert.equal(mobility.travelerFit.maxContinuousWalkMeters, 800);
  assert.equal(mobility.travelerFit.accessibilityEvidence, "partial");
  assert.equal(mobility.travelerFit.stayAnchorFits[0].area, "人民广场");
  assert.ok(mobility.travelerFit.stayAnchorFits[0].alternatives.some((item) => item.mode === "transit"));
  assert.equal(mobility.legs[0].alternatives.find((item) => item.mode === "transit").realTimeArrival, false);
  const transit = mobility.legs[0].alternatives.find((item) => item.mode === "transit");
  assert.deepEqual(transit.steps[0].walkType, { code: "9", kind: "elevator", label: "直梯" });
  assert.deepEqual(transit.accessibilityFeatures.map(({ kind, status, realTime }) => ({ kind, status, realTime })), [{ kind: "elevator", status: "mapped_non_realtime", realTime: false }]);
  assert.equal(calls.find((item) => item.pathname.includes("transit"))?.searchParams.get("strategy"), "3");
  assert.equal(calls.find((item) => item.pathname.includes("transit"))?.searchParams.get("date"), "2026-10-03");
  const recommended = mobility.legs[0].alternatives.find((item) => item.mode === mobility.legs[0].recommendedMode);
  const map = await provider.renderStaticMap({ points: mobility.legs.flatMap((leg) => [leg.origin, leg.destination]), paths: [recommended.polyline] });
  assert.equal(map.contentType, "image/png");
});

test("AMap transit preserves railway and segment geometry without synthesizing endpoint lines", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v3/geocode/geo") return new Response(JSON.stringify({ status: "1", infocode: "10000", geocodes: [{ citycode: "021", adcode: "310000", location: "121.47,31.23" }] }));
    if (parsed.pathname === "/v5/direction/transit/integrated") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ distance: "5000", walking_distance: "100", cost: { duration: "1200", transit_fee: "4" }, segments: [{ railway: { name: "地铁 2 号线", departure_stop: { name: "人民广场" }, arrival_stop: { name: "陆家嘴" }, time: "900", distance: "4500", steps: [{ polyline: "121.4700,31.2300;121.4900,31.2400" }] } }] }] } }));
    if (parsed.pathname === "/v5/direction/driving") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "5000", cost: { duration: "800", taxi: "25" }, steps: [] }] } }));
    if (parsed.pathname === "/v5/direction/walking") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "2200", cost: { duration: "1800" }, steps: [] }] } }));
    throw new Error(`unexpected path ${parsed.pathname}`);
  };
  const provider = new AmapTravelResearchProvider({ apiKey: "test-key", fetchImpl, requestIntervalMs: 0, rateLimitRetryMs: 0 });
  const mobility = normalizeTripMobility(await provider.planMobility({
    brief: { destination: "上海" },
    selectedNodes: [
      { nodeId: "a", domain: "stay", title: "A", selected: true, location: { citycode: "021", coordinates: point(121.47, 31.23) } },
      { nodeId: "b", domain: "play", title: "B", selected: true, location: { citycode: "021", coordinates: point(121.49, 31.24) } },
    ],
  }));
  const transit = mobility.legs[0].alternatives.find((item) => item.mode === "transit");
  assert.equal(transit.polyline.length, 2);
  assert.equal(transit.steps[0].line, "地铁 2 号线");
  assert.equal(transit.steps[0].polyline.length, 2);
});

test("AMap mobility rejects an otherwise short route with mapped stairs for a traveler who must avoid them", async () => {
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/v3/geocode/geo") return new Response(JSON.stringify({ status: "1", infocode: "10000", geocodes: [{ citycode: "021", adcode: "310000", location: "121.473701,31.230416" }] }));
    if (pathname === "/v5/direction/transit/integrated") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ distance: "2200", walking_distance: "300", cost: { duration: "900", transit_fee: "3" }, segments: [{ walking: { steps: [{ instruction: "经阶梯进站", distance: "300", duration: "240", walk_type: "20" }] }, bus: { buslines: [{ name: "地铁测试线", departure_stop: { name: "甲站" }, arrival_stop: { name: "乙站" }, duration: "480", distance: "1500" }] } }] }] } }));
    if (pathname === "/v5/direction/driving") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "2600", cost: { duration: "600", taxi: "18" }, steps: [{ instruction: "驾车前往", step_distance: "2600", cost: { duration: "600" } }] }] } }));
    if (pathname === "/v5/direction/walking") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "1800", cost: { duration: "1500" }, steps: [{ instruction: "经阶梯步行", step_distance: "1800", cost: { duration: "1500" }, navi: { walk_type: "20" } }] }] } }));
    throw new Error(`unexpected path ${pathname}`);
  };
  const provider = new AmapTravelResearchProvider({ apiKey: "test-key", fetchImpl, requestIntervalMs: 0, rateLimitRetryMs: 0 });
  const mobility = normalizeTripMobility(await provider.planMobility({
    brief: { destination: "上海" },
    travelers: [{ travelerId: "traveler_father", careNeeds: { mobility: { reduceWalking: true, avoidStairs: true } } }],
    selectedNodes: [
      { nodeId: "a", domain: "stay", title: "A", selected: true, location: { citycode: "021", coordinates: { longitude: 121.473701, latitude: 31.230416 } } },
      { nodeId: "b", domain: "play", title: "B", selected: true, location: { citycode: "021", coordinates: { longitude: 121.49, latitude: 31.24 } } },
    ],
  }));

  assert.equal(mobility.legs[0].recommendedMode, "taxi");
  assert.equal(mobility.travelerFit.maxContinuousWalkMeters, null, "an internal cautious target must not be presented as a user-stated limit");
  const transit = mobility.legs[0].alternatives.find((alternative) => alternative.mode === "transit");
  assert.equal(transit.accessibilityAssessment.hasStairs, true);
  assert.equal(transit.steps[0].accessibilityFeatures[0].guidance.includes("避开台阶"), true);
});

test("AMap mobility connects an intercity arrival airport to the selected hotel", async () => {
  const geocodedAddresses = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v3/geocode/geo") {
      const address = parsed.searchParams.get("address");
      geocodedAddresses.push(address);
      const location = address === "大理机场" ? "100.319000,25.649000" : "100.165000,25.693000";
      return new Response(JSON.stringify({ status: "1", infocode: "10000", geocodes: [{ citycode: "0872", adcode: "532901", location }] }));
    }
    if (parsed.pathname === "/v5/direction/transit/integrated") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ distance: "30000", walking_distance: "350", cost: { duration: "3600", transit_fee: "10" }, segments: [{ bus: { buslines: [{ name: "机场巴士", departure_stop: { name: "大理机场" }, arrival_stop: { name: "大理古城" }, duration: "3300", distance: "29500" }] } }] }] } }));
    if (parsed.pathname === "/v5/direction/driving") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "30000", cost: { duration: "2400", taxi: "90" }, steps: [{ instruction: "从机场前往酒店", step_distance: "30000", cost: { duration: "2400" } }] }] } }));
    if (parsed.pathname === "/v5/direction/walking") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "30000", cost: { duration: "22000" }, steps: [{ instruction: "步行前往", step_distance: "30000", cost: { duration: "22000" } }] }] } }));
    throw new Error(`unexpected path ${parsed.pathname}`);
  };
  const provider = new AmapTravelResearchProvider({ apiKey: "test-key", fetchImpl, requestIntervalMs: 0, rateLimitRetryMs: 0 });

  const mobility = normalizeTripMobility(await provider.planMobility({
    brief: { destination: "大理", dates: "2026-09-03 至 2026-09-07" },
    selectedNodes: [
      { nodeId: "flight_cz3481", domain: "transport", title: "CZ3481 广州 → 大理", selected: true, operability: { mobilityRole: "intercity_inventory", arrivalPlace: { kind: "airport", city: "大理", label: "大理机场", terminal: null } } },
      { nodeId: "stay_old_town", domain: "stay", title: "大理古城酒店", selected: true, location: { citycode: "0872", coordinates: { longitude: 100.165, latitude: 25.693 } } },
    ],
  }));

  assert.equal(mobility.status, "completed");
  assert.equal(mobility.legs[0].origin.nodeId, "flight_cz3481");
  assert.equal(mobility.legs[0].origin.label, "大理机场");
  assert.equal(mobility.legs[0].destination.nodeId, "stay_old_town");
  assert.match(mobility.legs[0].rationale, /抵达后的接驳/);
  assert.deepEqual(geocodedAddresses, ["大理", "大理机场"]);
});

test("AMap taxi rationale audits walking and transfer thresholds without treating unknown accessibility as stairs", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v3/geocode/geo") {
      const airport = /浦东/.test(parsed.searchParams.get("address") ?? "");
      return new Response(JSON.stringify({ status: "1", infocode: "10000", geocodes: [{ citycode: "021", adcode: "310000", location: airport ? "121.807928,31.152777" : "121.473701,31.230416" }] }));
    }
    if (parsed.pathname === "/v5/direction/transit/integrated") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { transits: [{ distance: "47000", walking_distance: "1128", cost: { duration: "9780", transit_fee: "26" }, segments: [{ walking: { steps: [{ instruction: "乘扶梯进入车站", distance: "500", duration: "420", navi: { walk_type: "8" } }] }, bus: { buslines: [{ name: "地铁2号线", departure_stop: { name: "浦东机场" }, arrival_stop: { name: "世纪大道" }, duration: "3600", distance: "30000" }] } }, { bus: { buslines: [{ name: "地铁4号线", departure_stop: { name: "世纪大道" }, arrival_stop: { name: "西藏南路" }, duration: "1800", distance: "10000" }] } }, { bus: { buslines: [{ name: "地铁8号线", departure_stop: { name: "西藏南路" }, arrival_stop: { name: "人民广场" }, duration: "1200", distance: "5000" }] } }] }] } }));
    if (parsed.pathname === "/v5/direction/driving") return new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [{ distance: "47000", cost: { duration: "3120", taxi: "151" }, steps: [{ instruction: "驾车前往人民广场", step_distance: "47000", cost: { duration: "3120" } }] }] } }));
    throw new Error(`unexpected path ${parsed.pathname}`);
  };
  const provider = new AmapTravelResearchProvider({ apiKey: "test-key", fetchImpl, requestIntervalMs: 0, rateLimitRetryMs: 0 });
  const mobility = normalizeTripMobility(await provider.planMobility({
    brief: { destination: "上海", dates: "2026-08-27 至 2026-08-29", arrivalTime: "14:00" },
    travelers: [{ travelerId: "traveler_2", displayName: "父亲", careNeeds: { mobility: { maxContinuousWalkMeters: 600, avoidStairs: true } } }],
    selectedNodes: [
      { nodeId: "arrival_pvg_t2", domain: "transport", title: "已确认抵达：浦东机场 T2", selected: true, operability: { mobilityRole: "user_confirmed_arrival", arrivalRouteAnchor: { kind: "airport", city: "上海", label: "浦东机场 T2", terminal: "T2", time: "14:00" } } },
      { nodeId: "stay_people_square", domain: "stay", title: "人民广场酒店", selected: true, location: { citycode: "021", coordinates: { longitude: 121.473701, latitude: 31.230416 } } },
    ],
  }));

  const leg = mobility.legs[0];
  assert.equal(leg.recommendedMode, "taxi");
  assert.match(leg.rationale, /1128 米.*600 米目标/);
  assert.match(leg.rationale, /换乘 2 次.*1 次目标/);
  assert.match(leg.rationale, /52 分钟.*步行 0 米.*换乘 0 次/);
  assert.match(leg.rationale, /未知项不是本次推荐打车的直接触发条件/);
  assert.doesNotMatch(leg.rationale, /已发现楼梯/);
  assert.deepEqual(leg.recommendationAudit.triggers, ["transit_walking_exceeds_target", "transit_transfers_exceed_target"]);
  assert.equal(leg.recommendationAudit.transit.hasEscalator, true);
  assert.equal(leg.recommendationAudit.transit.hasStairs, false);
  assert.deepEqual(leg.recommendationAudit.accessibilityEvidence, { status: "not_verified", directTrigger: false });
  assert.equal(mobility.travelerFit.planningWalkingTarget, 600);
  assert.equal(mobility.travelerFit.planningTransferTarget, 1);
  assert.equal(mobility.travelerFit.transferTargetSource, "reduced_mobility_default");
});

test("AMap mobility keeps account gates distinct from QPS and returns an honest unavailable state", async () => {
  const provider = new AmapTravelResearchProvider({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({ status: "0", info: "USER_DAILY_QUERY_OVER_LIMIT", infocode: "10044" }), { headers: { "content-type": "application/json" } }),
    requestIntervalMs: 0,
    rateLimitRetryMs: 0,
  });
  const result = await provider.planMobility({
    brief: { destination: "上海" },
    selectedNodes: [
      { nodeId: "stay", domain: "stay", title: "酒店", selected: true, location: { coordinates: { longitude: 121.47, latitude: 31.23 } } },
      { nodeId: "play", domain: "play", title: "景点", selected: true, location: { coordinates: { longitude: 121.49, latitude: 31.24 } } },
    ],
  });
  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.reason, "ACCOUNT_LIMITED");
});

test("mobility contract rejects arbitrary navigation URLs", () => {
  assert.throws(() => normalizeTripMobility({
    status: "completed",
    source: "amap_routes_v5",
    checkedAt: "2026-08-16T08:00:00.000Z",
    legs: [{
      legId: "unsafe_leg",
      origin: { nodeId: "a", label: "A", coordinates: { longitude: 121.47, latitude: 31.23 } },
      destination: { nodeId: "b", label: "B", coordinates: { longitude: 121.49, latitude: 31.24 } },
      recommendedMode: "walk",
      rationale: "测试",
      alternatives: [{ mode: "walk", totalMinutes: 10, navigationUrl: "https://evil.example/collect", steps: [{ kind: "walk", instruction: "步行" }] }],
    }],
  }), (error) => error.code === "invalid_trip_mobility" && error.details.field.includes("navigationUrl"));
});
