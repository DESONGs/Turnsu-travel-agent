import { useCallback, useEffect, useState } from "react";
import { JournalPanel } from "./workspace/JournalPanel.jsx";
import { workspaceHost } from "./workspace/workspace-host.mjs";

/** All journal entry points use the same React editor and cloud records. */
export function TravelPhotoJournal({ node = null, tripId, plan, context, onClose, onDirtyChange, onStatusChange, tripTitle }) {
  const [access, setAccess] = useState(null), [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true; setAccess(null); setError("");
    workspaceHost.call("get_trip_workspace_access", { tripId }).then(value => { if (active) setAccess(value); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [tripId, attempt]);
  const status = useCallback(value => { onDirtyChange?.(value.dirty || value.busy || value.uncertain); onStatusChange?.(value); }, [onDirtyChange, onStatusChange]);
  const visits = (plan?.itinerary?.stops ?? plan?.mobility?.itinerary?.stops ?? []).map(stop => ({ stopId: stop.stopId, name: stop.title, date: stop.date }));
  if (!access) return <section className="journal-workspace"><h2>照片手账</h2>{error ? <><p role="alert">{error}</p><button type="button" className="ui-secondary" onClick={() => retry(value => value + 1)}>重新读取手账</button></> : <p role="status">正在读取这趟旅行的记录与权限…</p>}</section>;
  return <JournalPanel key={tripId} host={workspaceHost} tripId={tripId} revision={plan?.revision ?? access.revision} canEdit={(plan?.accessRole ?? access.role) !== "viewer"}
    place={context ?? (node ? { name: node.title, domain: node.domain } : null)} visits={visits} selectedDate={context?.date || ""}
    onClose={onClose} onStatusChange={status} tripTitle={tripTitle || "这趟旅行"} />;
}
