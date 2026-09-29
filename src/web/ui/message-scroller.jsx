import { useEffect, useLayoutEffect, useRef, useState } from "react";

const FOLLOW_THRESHOLD = 72;

export function MessageScroller({ children, busy = false, resetKey = "", jumpLabel = "回到最新消息" }) {
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const followsOutputRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const updateFollowState = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceToEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const followsOutput = distanceToEnd <= FOLLOW_THRESHOLD;
    followsOutputRef.current = followsOutput;
    setShowJump(!followsOutput);
  };

  const scrollToEnd = (behavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followsOutputRef.current = true;
    setShowJump(false);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  };

  useLayoutEffect(() => {
    followsOutputRef.current = true;
    setShowJump(false);
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
  }, [resetKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (followsOutputRef.current) scrollToEnd("smooth");
      else updateFollowState();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return <div className="message-scroller-frame">
    <div ref={viewportRef} className="message-scroller" role="log" aria-live="polite" aria-relevant="additions text" aria-busy={busy} onScroll={updateFollowState} onWheel={(event) => { if (event.deltaY < 0) followsOutputRef.current = false; }} onTouchMove={() => { followsOutputRef.current = false; }}>
      <div ref={contentRef} className="message-scroller-content">{children}</div>
    </div>
    {showJump ? <button type="button" className="message-scroll-jump" onClick={() => scrollToEnd()}>{jumpLabel}</button> : null}
  </div>;
}
