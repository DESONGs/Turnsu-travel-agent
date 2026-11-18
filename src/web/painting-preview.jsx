import { useEffect, useRef } from "react";
import "./painting-preview.css";
import { ArrowLeft, ArrowCounterClockwise, ArrowRight, HandGrabbing } from "@phosphor-icons/react";

export function PaintingPreview({ drawing, title, english }) {
  const mount = useRef(null), control = useRef(null);
  const pick = (zh, en) => english ? en : zh;
  useEffect(() => {
    const stage = mount.current;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    stage.replaceChildren(...drawing.plates.map(p => p.canvas));
    let x = 0, y = 0, tx = 0, ty = 0, frame = 0, lastTime = 0, pointer = null;
    function paint() {
      const min = Math.min(stage.clientWidth,stage.clientHeight);
      for (const { canvas, depth } of drawing.plates) {
        const z = (depth-2)/2;
        canvas.style.transform = `translate3d(${x*z*min*.016}px,${y*z*min*.009}px,0) scale(1.038)`;
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
    control.current=move; paint();
    return () => {
      for (const [event,func] of Object.entries(events)) stage.removeEventListener(event,func);
      cancelAnimationFrame(frame); observer.disconnect(); stage.replaceChildren(); control.current=null;
    };
  }, [drawing]);
  return <div className="painting-preview">
    <div className="painting-stage" style={{ aspectRatio: drawing.width / drawing.height, "--painting-ratio": drawing.width / drawing.height }} ref={mount} role="img" aria-label={pick(`${title}的分层手绘`, `Layered illustration of ${title}`)} />
    <div className="painting-view-controls"><span><HandGrabbing />{pick("拖动查看，松手回正", "Drag to explore · release to center")}</span><div role="group" aria-label={pick("手绘视角", "Illustration view")}>
    {[[ArrowLeft,-1,"向左看","Look left"],[ArrowCounterClockwise,0,"回正","Center"],[ArrowRight,1,"向右看","Look right"]].map(([Icon,angle,zh,en])=><button type="button" key={angle} className="button secondary" aria-label={pick(zh,en)} onClick={()=>control.current?.(angle)}><Icon /></button>)}</div></div>
  </div>;
}
