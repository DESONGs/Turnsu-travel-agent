const text=v=>typeof v==='string'&&v.trim()&&!/^(unknown|not_checked|pending|待核验)$/i.test(v)?v.trim():null;
const fail=code=>{throw Object.assign(new Error(code),{code})};
/** A complete offer identity, not merely the property's or flight's headline price. */
export function watchOffer(node,brief={}){
  const o=node?.operability??{},p=node?.price??{};const kind=node?.domain==='stay'?'hotel':node?.domain==='transport'&&['FLIGHT','flight'].includes(o.transportType)?'flight':null;
  const rawDates=o.serviceDates??brief.dates??[];
  const dates=(Array.isArray(rawDates)?rawDates:String(rawDates).match(/\d{4}-\d{2}-\d{2}/g)??[]).map(d=>String(d).slice(0,10));
  const party=o.priceParty??o.party??brief.party??{};
  const conditions={kind,provider:text(o.provider),providerRef:text(o.providerRef),dates,adults:party.adults??null,childrenAges:party.childrenAges??[],rooms:kind==='hotel'?party.rooms??null:null,product:text(kind==='hotel'?o.roomName??o.roomType:o.cabinClass??o.fareClass),meal:kind==='hotel'?text(o.mealPlan):'not_applicable',refund:text(o.cancellationPolicy??o.refundPolicy),baggage:kind==='flight'?text(o.baggageAllowance??o.baggage):'not_applicable',tax:['included','excludes_some_taxes_or_fees'].includes(p.taxStatus)?p.taxStatus:null,currency:text(p.currency),priceUnit:text(p.unit)};
  const missing=Object.entries(conditions).filter(([k,v])=>v==null&&k!=='rooms'||k==='rooms'&&kind==='hotel'&&!v).map(([k])=>k);
  if(dates.length!==2||dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)))missing.push('dates');
  if(!Number.isInteger(conditions.adults)||conditions.adults<1)missing.push('adults');
  if(!['per_booking','per_order'].includes(conditions.priceUnit))missing.push('priceUnit');
  if(!o.inventoryVerified||!Number.isFinite(p.amount))missing.push('verified_quote');
  if(node?.lock?.kind==='booked')missing.push('already_booked');
  return {eligible:!!kind&&!missing.length,missing:[...new Set(missing)],conditions,amount:p.amount??null,checkedAt:Date.parse(p.checkedAt??o.checkedAt??''),bookingUrl:o.bookingUrl??null};
}
export function createWatchQuoteSource(travelService){return {async check(watch,signal){
  const state=await travelService.store.get(watch.tripId);if(!state||!watch.ownerUserId||!state.collaboration?.memberUserIds?.includes(watch.ownerUserId))fail('trip_access_revoked');
  const provider=travelService.researchProvider;if(!provider?.research)fail('quote_unavailable');
  const c=watch.conditions;
  const brief={...state.brief,dates:c.dates,party:{adults:c.adults,childrenAges:c.childrenAges,...(c.rooms?{rooms:c.rooms}:{})},currency:c.currency};
  const result=await provider.research({tripId:state.tripId,brief,travelers:state.travelers,domains:[c.kind==='hotel'?'stay':'transport'],criteria:{},includeWeather:false,signal});
  signal.throwIfAborted();
  const rows=Object.values(result.byDomain??{}).flat();
  const node=rows.find(n=>n.operability?.provider===c.provider&&n.operability?.providerRef===c.providerRef);
  if(!node)fail('quote_unavailable');const quote=watchOffer(node,brief);if(!quote.eligible)fail('quote_unavailable');
  return {amount:quote.amount,checkedAt:quote.checkedAt,conditions:quote.conditions,...(quote.bookingUrl?{bookingUrl:quote.bookingUrl}:{})};
}};}
