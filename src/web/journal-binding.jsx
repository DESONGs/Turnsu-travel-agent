import { CaretDown, Check, LockSimple } from "@phosphor-icons/react";
import { journalTemplates } from "../media/journal-templates.js";
import { journalSurface } from "./journal-materials.js";

export function TemplatePicker({ value, onChange, english, disabled }) {
  const lang = english ? "en" : "zh";
  return <details className="binding-picker">
    <summary><span className="binding-chip" style={journalSurface(value)} aria-hidden="true"/>
      <span className="binding-label">{english ? "Binding" : "装帧"}</span><span>{journalTemplates[value][lang]}</span><CaretDown aria-hidden="true"/>
      <span className="visually-hidden">{english ? " · Choose a binding" : " · 选择装帧"}</span>
    </summary>
    <fieldset className="binding-options" disabled={disabled}>
      <legend className="visually-hidden">{english ? "Page binding" : "本页装帧"}</legend>
      {Object.entries(journalTemplates).sort(([a],[b]) => Number(a === "plain") - Number(b === "plain")).map(([id, template]) =>
        <label key={id}><input type="radio" name="page-binding" value={id} checked={value === id} onChange={() => onChange(id)}/>
          <span className="binding-chip" style={journalSurface(id)} aria-hidden="true"/>
          <span className="binding-name">{template[lang]}</span>{value === id && <Check aria-hidden="true"/>}
        </label>)}
    </fieldset>
  </details>;
}

export function CoverFace({ title, thumbnail, count, english }) {
  return <>
    <span className="cover-title">{english ? "Travel journal" : "旅行手账"}</span>
    {thumbnail && <img className="cover-photo" src={thumbnail} alt=""/>}
    <span className="cover-caption">{title && <span>{title}</span>}
      <span>{english ? count + (count === 1 ? " entry" : " entries") : count + " 篇回忆"}</span>
    </span>
    <i className="book-ribbon" aria-hidden="true"/>
  </>;
}

export function PrivateLabel({ english }) {
  return <small className="book-private"><LockSimple aria-hidden="true"/>{english ? "Only you" : "仅自己可见"}</small>;
}

// Decorative leaf only. The new page becomes readable and operable immediately.
export function TurningLeaf({ motion, english, finish }) {
  if (!motion) return null;
  return <div className={"turning-leaf turn-" + motion.direction} style={journalSurface(motion.binding)} aria-hidden="true" onAnimationEnd={finish}>
    {motion.direction === "open" ? <span className="turn-cover binding-surface"><span className="cover-title">{english ? "Travel journal" : "旅行手账"}</span></span>
      : <span className="turn-paper"><b>{motion.title}</b><span>{motion.note}</span></span>}
  </div>;
}
