import { useMemo, useState } from "react";
import { ArrowRight, BookOpen, MapTrifold } from "@phosphor-icons/react";
import { buildDestinationExperienceScene, buildDestinationTrialSelection } from "./destination-experience-scene.js";
import { DestinationSketchWorld } from "./destination-sketch-world.jsx";
import "./destination-sketch.css";

export function DestinationExperiencePreview({ node, plan, locale = "zh-CN", onTrialCandidate, onOpenEvidence, onOpenJournal }) {
  const scene = useMemo(() => buildDestinationExperienceScene({ node, plan }), [node, plan]);
  const [selectedId, setSelectedId] = useState("place");
  const [failedMediaId, setFailedMediaId] = useState(null);
  if (!scene) return null;
  const english = locale === "en";
  const chapter = scene.sketch.hotspots.find((hotspot) => hotspot.id === selectedId) ?? scene.sketch.hotspots[0];
  const trialSelection = onTrialCandidate ? buildDestinationTrialSelection(scene) : null;
  const media = scene.media.find((item) => item.mediaId === chapter.mediaId) ?? scene.media[0];
  const showPhoto = chapter.kind === "photo" && media && media.mediaId !== failedMediaId;
  const trialLabel = node.selected ? (english ? "Already in this trip" : "已在当前旅行中") : trialSelection ? (english ? "Add to route draft" : "加入路线试排") : !onTrialCandidate ? (english ? "Option no longer available" : "候选已变化，暂不能试排") : (english ? "Coordinates needed for drafting" : "坐标待补，暂不能试排");
  const description = chapter.pending && english ? "No verified route yet. Draft it to check time, walking and budget impact." : chapter.text;
  return <section className="destination-sketch-preview" aria-labelledby="destination-experience-title">
    <DestinationSketchWorld scene={scene} selectedId={chapter.id} onSelect={setSelectedId} locale={locale} />
    <div className={`destination-sketch-reading ${showPhoto ? "with-photo" : ""}`}>
      {showPhoto ? <figure><img src={media.displayUrl} alt={media.alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedMediaId(media.mediaId)} /><figcaption>{media.source}</figcaption></figure> : null}
      <div className="destination-sketch-note" aria-live="polite" aria-atomic="true">
        <span>{english ? chapter.englishLabel : chapter.label}<small>{chapter.source}</small></span>
        <p>{chapter.kind === "photo" && media?.mediaId === failedMediaId ? (english ? "This source photo could not load. Open the full evidence or try again later." : "这张来源照片暂时未能载入，可查看完整资料或稍后重试。") : description}</p>
        {chapter.kind === "place" ? <small className="destination-sketch-basis">{scene.sketch.theme.basis ? (english ? `Illustration theme from this option's ${scene.sketch.theme.basis.field}: ${scene.sketch.theme.basis.excerpt}` : `主题依据：${scene.sketch.theme.basis.field === "domain" ? scene.domainLabel : `资料中的「${scene.sketch.theme.basis.excerpt}」`}；图中景物为风格化表达。`) : (english ? "No specific landscape is supported yet; this page uses a neutral notebook." : "尚无足够资料判断景观类型，先以中性手账呈现。")}</small> : null}
      </div>
      {onOpenEvidence ? <button type="button" className="destination-sketch-evidence" onClick={onOpenEvidence}><BookOpen />{english ? "Full evidence" : "查看完整资料"}<ArrowRight /></button> : null}
      {onOpenJournal ? <button type="button" className="destination-sketch-evidence" onClick={onOpenJournal}>{english ? "My photos & memories" : "记录我的照片"}<ArrowRight /></button> : null}
    </div>
    <footer className="destination-sketch-footer">
      <span>{english ? "Explore first. Changes need your confirmation." : "先看看，再决定。试排后仍需你确认。"}</span>
      <button type="button" className="button primary" disabled={!trialSelection} onClick={() => { if (trialSelection) onTrialCandidate?.(trialSelection); }}><MapTrifold />{trialLabel}<ArrowRight /></button>
    </footer>
  </section>;
}
