import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { TripStateSchema } from '../contracts/index.js';
import type { TripState } from '../contracts/index.js';
import { stripGoogleContent } from '../core/provider-content.js';
import { decisionHash } from '../host/travel-decision-policy.js';
const fingerprint=(state:TripState)=>{const s=stripGoogleContent(state);return decisionHash([s.brief,s.travelers,s.nodes,s.edges,s.pendingProposals,s.planning,s.fulfillmentLedger,s.fulfillmentEvents,s.feedbackLedger]);};
export function recentTripChangeAvailable(s:TripState):boolean{return Boolean(s.recentChange&&s.recentChange.appliedRevision===s.revision&&s.recentChange.fingerprint===fingerprint(s));}
export function withRecentTripChange(before:TripState,after:TripState):TripState{
 const previous=structuredClone(before);delete previous.recentChange;
 const beforeJson=JSON.stringify(stripGoogleContent(previous));
 if(Buffer.byteLength(beforeJson)>5_000_000)throw new Error('undo_snapshot_too_large');
 return {...after,recentChange:{changeId:randomUUID(),appliedRevision:after.revision,fingerprint:fingerprint(after),beforeJson}};
}
/** Undo is another monotonic commit. Concurrent work and changed locks refuse it. */
export function restoreRecentTripChange(current:TripState,changeId:string,baseRevision:number,at:string):TripState{
 const undo=current.recentChange;
 if(!undo||undo.changeId!==changeId||current.revision!==baseRevision||undo.appliedRevision!==current.revision||fingerprint(current)!==undo.fingerprint)throw Object.assign(new Error('undo_stale'),{code:'undo_stale',status:409});
 const before:unknown=JSON.parse(undo.beforeJson);
 if(!Value.Check(TripStateSchema,before)||before.tripId!==current.tripId)throw Object.assign(new Error('undo_snapshot_invalid'),{code:'undo_snapshot_invalid'});
 const next:TripState={...before,revision:current.revision+1,storageVersion:current.storageVersion,updatedAt:at,changeJournal:[...current.changeJournal,{kind:'undo',changeId,at,revision:current.revision+1}],proposalHistory:current.proposalHistory,fulfillmentLedger:current.fulfillmentLedger,fulfillmentEvents:current.fulfillmentEvents,feedbackLedger:current.feedbackLedger};
 if(current.collaboration)next.collaboration=current.collaboration;else delete next.collaboration;
 delete next.recentChange;return next;
}
