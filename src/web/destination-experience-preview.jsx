import { useMemo } from "react";
import { ArrowRight, BookOpen, MapTrifold } from "@phosphor-icons/react";
import { buildDestinationExperienceScene, buildDestinationTrialSelection } from "./destination-experience-scene.js";
import { DestinationPaintingWorkspace } from "./destination-painting-workspace.jsx";
import "./destination-sketch.css";
import "./destination-photo-scene.css";

export function DestinationExperiencePreview({ node, plan, locale = "zh-CN", inDraft = false, onTrialCandidate, onOpenEvidence, onOpenJournal, onDirtyChange }) {
  const scene = useMemo(() => buildDestinationExperienceScene({ node, plan }), [node, plan]);
  const english = locale === "en", pick = (zh, en) => english ? en : zh;
  if (!scene) return null;
  const trialSelection = onTrialCandidate ? buildDestinationTrialSelection(scene) : null;
  const trialLabel = node.selected ? pick("已在当前旅行中", "Already in this trip") : trialSelection && inDraft ? pick("移出路线试排", "Remove from route draft") : trialSelection ? pick("加入路线试排", "Add to route draft") : !onTrialCandidate ? pick("候选已变化，暂不能试排", "Option no longer available") : pick("坐标待补，暂不能试排", "Coordinates needed for drafting");
  return <section className="destination-sketch-preview destination-photo-scene" aria-labelledby="destination-experience-title">
    <header className="destination-photo-heading"><small>{pick("立体视角 · 来源照片与手绘分镜", "3D Scene · Verified Photos & Ink Layers")}</small><h2 id="destination-experience-title">{scene.title}</h2></header>
    <DestinationPaintingWorkspace key={node.nodeId} scene={scene} node={node} tripId={plan?.tripId} english={english} onDirtyChange={onDirtyChange} />
    <div className="destination-photo-details">
      <p>{scene.facts.find((fact) => fact.label === "此行体验线索")?.value || scene.title}</p>
      {scene.routeRelation ? <p>{scene.routeRelation.label}{scene.routeRelation.minutes != null ? pick(` · 约 ${Math.round(scene.routeRelation.minutes)} 分钟`, ` · about ${Math.round(scene.routeRelation.minutes)} min`) : ""}</p> : null}
      <div>{onOpenEvidence ? <button type="button" className="destination-sketch-evidence" onClick={onOpenEvidence}><BookOpen />{pick("查看完整资料", "Full evidence")}<ArrowRight /></button> : null}{onOpenJournal ? <button type="button" className="destination-sketch-evidence" onClick={onOpenJournal}>{pick("我的照片手账", "My photo journal")}<ArrowRight /></button> : null}</div>
    </div>
    <footer className="destination-sketch-footer"><span>{pick("先看看，再决定。试排后仍需你确认。", "Explore first. Changes need your confirmation.")}</span><button type="button" className="button primary" disabled={!trialSelection} onClick={() => { if (trialSelection) onTrialCandidate?.(trialSelection); }}><MapTrifold />{trialLabel}<ArrowRight /></button></footer>
  </section>;
}
