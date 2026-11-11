// The render loop sleeps once the scene is still. No interval or idle animation.
export function createSketchFrameLoop({ requestFrame, cancelFrame, render, step = () => false }) {
  let frame = null;
  let disposed = false;
  let paused = false;
  const invalidate = () => {
    if (disposed || paused || frame !== null) return;
    frame = requestFrame((time) => {
      frame = null;
      if (disposed || paused) return;
      const moving = step(time);
      render();
      if (moving) invalidate();
    });
  };
  const pause = () => { paused = true; if (frame !== null) cancelFrame(frame); frame = null; };
  return {
    invalidate,
    pause,
    resume() { if (disposed) return; paused = false; invalidate(); },
    dispose() { pause(); disposed = true; },
  };
}

const mix = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

export function createSketchTour({ readCamera, writeCamera, onChapter, onState, reducedMotion = false, duration = 7200 }) {
  let run = null;
  let disposed = false;
  function stop() {
    if (!run) return;
    run = null;
    onState?.(false);
  }
  return {
    start(beats, now) {
      if (disposed || reducedMotion || !beats.length) return false;
      stop();
      run = { beats, from: readCamera(), startedAt: now, index: -1 };
      onState?.(true);
      return true;
    },
    step(now) {
      if (!run || disposed) return false;
      const progress = Math.min(1, Math.max(0, (now - run.startedAt) / duration));
      const rawIndex = progress * run.beats.length;
      const index = Math.min(run.beats.length - 1, Math.floor(rawIndex));
      if (index !== run.index) { run.index = index; onChapter?.(run.beats[index].id); }
      const from = index === 0 ? run.from : run.beats[index - 1];
      const to = run.beats[index];
      // Each beat settles briefly before moving to the next point.
      const t = ease(Math.min(1, (rawIndex - index) / 0.78));
      writeCamera({ position: from.position.map((n, i) => mix(n, to.position[i], t)), target: from.target.map((n, i) => mix(n, to.target[i], t)), zoom: mix(from.zoom, to.zoom, t) });
      if (progress === 1) stop();
      return Boolean(run);
    },
    stop,
    get playing() { return Boolean(run); },
    dispose() { stop(); disposed = true; },
  };
}
