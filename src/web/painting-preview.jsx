import { useLayoutEffect, useRef, useState } from "react";
import "./painting-preview.css";
import { ArrowsOutLineHorizontal, ArrowLeft, ArrowCounterClockwise, ArrowRight, HandGrabbing } from "@phosphor-icons/react";

function PhotoComparison({ photo, alt, english }) {
  const [percent, setPercent] = useState(50);
  return <div className="photo-comparison" style={{ "--revealed": percent + "%" }}>
    <div className="comparison-original"><img src={"data:image/jpeg;base64," + photo.data} alt={alt} draggable={false}/></div>
    {percent > 18 && <span className="comparison-legend original" aria-hidden="true">{english ? "Original" : "原照"}</span>}
    {percent < 82 && <span className="comparison-legend drawing" aria-hidden="true">{english ? "Drawing" : "手绘"}</span>}
    <div className="comparison-divider" aria-hidden="true"><ArrowsOutLineHorizontal weight="bold"/></div>
    <input type="range" min="0" max="100" step="1" value={percent}
      aria-label={english ? "Original photo percentage" : "原照显示比例"}
      aria-valuetext={english ? percent + "% original" : "原照 " + percent + "%"}
      onChange={event => setPercent(Number(event.target.value))}/>
  </div>;
}

export function PaintingPreview({ drawing, title, english, comparisonPhoto, originalAlt }) {
  const mount = useRef(null), control = useRef(null);
  const pick = (zh, en) => english ? en : zh;
  const comparing = Boolean(comparisonPhoto);
  useLayoutEffect(() => {
    const stage = mount.current;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    stage.replaceChildren(...drawing.plates.map(p => p.canvas));
    let x = 0, y = 0, tx = 0, ty = 0, frame = 0, lastTime = 0, pointer = null;
    function paint() {
      const min = Math.min(stage.clientWidth,stage.clientHeight);
      for (const { canvas, depth } of drawing.plates) {
        const z = (depth-2)/2;
        canvas.style.transform = `translate3d(${x*z*min*.016}px,${y*z*min*.009}px,0) scale(var(--painting-scale, 1.038))`;
      }
    }
    function tick(time) {
      const ease = reduced.matches ? 1 : 1-Math.exp(-Math.min(64, time-lastTime || 16)/(pointer ? 38 : 135));
      lastTime = time;
      x += (tx-x)*ease; y += (ty-y)*ease;
      if (Math.abs(tx-x)+Math.abs(ty-y)<.001) { x=tx; y=ty; frame=0; lastTime=0; paint(); return; }
      paint(); frame=requestAnimationFrame(tick);
    }
    function move(horizontal, vertical=0) {
      tx=Math.max(-1,Math.min(1,horizontal)); ty=Math.max(-1,Math.min(1,vertical));
      if (!frame) { lastTime=performance.now(); frame=requestAnimationFrame(tick); }
    }
    function start(event) {
      if (!event.isPrimary || event.button!==0 || pointer) return;
      pointer={id:event.pointerId,x:event.clientX,y:event.clientY,startX:x,startY:y};
      tx=x; ty=y; stage.setPointerCapture(event.pointerId);
    }
    function drag(event) {
      if (pointer?.id!==event.pointerId) return;
      move(pointer.startX+(event.clientX-pointer.x)/Math.max(45,stage.clientWidth*.25),pointer.startY+(event.clientY-pointer.y)/Math.max(45,stage.clientHeight*.3));
    }
    function end(event) {
      if (pointer?.id!==event.pointerId) return;
      pointer=null; move(0);
    }
    const events = { pointerdown:start, pointermove:drag, pointerup:end, pointercancel:end, lostpointercapture:end };
    for (const [event,func] of Object.entries(events)) stage.addEventListener(event,func);
    const observer=new ResizeObserver(paint); observer.observe(stage);
    function reset() {
      cancelAnimationFrame(frame);
      if (pointer && stage.hasPointerCapture(pointer.id)) stage.releasePointerCapture(pointer.id);
      pointer=null; x=0; y=0; tx=0; ty=0; frame=0; lastTime=0; paint();
    }
    control.current={ move, reset }; paint();
    return () => {
      for (const [event,func] of Object.entries(events)) stage.removeEventListener(event,func);
      cancelAnimationFrame(frame); observer.disconnect(); stage.replaceChildren(); control.current=null;
    };
  }, [drawing]);
  useLayoutEffect(() => { if (comparing) control.current?.reset(); }, [comparing]);
  return <div className="painting-preview">
    <div className="painting-frame" data-comparing={comparing || undefined} style={{ aspectRatio: drawing.width / drawing.height, "--painting-ratio": drawing.width / drawing.height }}>
      <div className="painting-stage" ref={mount} role="img" aria-label={pick(`${title}的分层手绘`, `Layered illustration of ${title}`)} />
      {comparing && <PhotoComparison photo={comparisonPhoto} alt={originalAlt} english={english}/>}
    </div>
    <div className="painting-view-controls">{comparing ? <span><ArrowsOutLineHorizontal />{pick("左右拖动分界线", "Slide to compare")}</span> :
      <><span><HandGrabbing />{pick("拖动查看，松手回正", "Drag to explore · release to center")}</span><div role="group" aria-label={pick("手绘视角", "Illustration view")}>
      {[[ArrowLeft,-1,"向左看","Look left"],[ArrowCounterClockwise,0,"回正","Center"],[ArrowRight,1,"向右看","Look right"]].map(([Icon,angle,zh,en])=><button type="button" key={angle} className="button secondary" aria-label={pick(zh,en)} onClick={()=>control.current?.move(angle)}><Icon /></button>)}</div></>}</div>
  </div>;
}
