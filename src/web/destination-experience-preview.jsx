import { useMemo } from "react";
import { MapTrifold } from "@phosphor-icons/react";
import { buildDestinationExperienceScene, buildDestinationTrialSelection } from "./destination-experience-scene.js";
import { DestinationPaintingWorkspace } from "./destination-painting-workspace.jsx";
import "./destination-sketch.css";
import "./destination-photo-scene.css";

export function DestinationExperiencePreview({ node, plan, locale = "zh-CN", inDraft = false, onTrialCandidate, onDirtyChange }) {
  const scene = useMemo(() => buildDestinationExperienceScene({ node, plan }), [node, plan]);
  const english = locale === "en", pick = (zh, en) => english ? en : zh;
  if (!scene) return null;
  const trialSelection = onTrialCandidate ? buildDestinationTrialSelection(scene) : null;
  const trialLabel = node.selected ? pick("已在当前旅行中", "Already in this trip") : trialSelection && inDraft ? pick("移出路线试排", "Remove from route draft") : trialSelection ? pick("加入路线试排", "Add to route draft") : !onTrialCandidate ? pick("候选已变化，暂不能试排", "Option no longer available") : pick("坐标待补，暂不能试排", "Coordinates needed for drafting");
  const trialAction = <button type="button" className="button secondary" disabled={!trialSelection}
    onClick={() => { if (trialSelection) onTrialCandidate(trialSelection); }}>
    <MapTrifold aria-hidden="true" />{trialLabel}
  </button>;
  return <section className="destination-sketch-preview destination-photo-scene" aria-label={scene.title}>
    <DestinationPaintingWorkspace key={node.nodeId} scene={scene} node={node} tripId={plan?.tripId}
      english={english} onDirtyChange={onDirtyChange} trialAction={trialAction} />
  </section>;
}
