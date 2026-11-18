import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export function prefersReducedMotion() {
  return Boolean(
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ||
    globalThis.navigator?.connection?.saveData,
  );
}

// Content is always visible. A superseded transition is cancelled rather than queued.
export function useContentMotion(ref, identity, { axis = "y", distance = 10, duration = 280 } = {}) {
  useEffect(() => {
    const element = ref.current;
    if (!element?.animate || prefersReducedMotion()) return;
    const animation = element.animate(
      [
        { opacity: 0.55, transform: `translate${axis.toUpperCase()}(${distance}px)` },
        { opacity: 1, transform: "translate(0, 0)" },
      ],
      { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    const stop = () => animation.cancel();
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    preference.addEventListener("change", stop);
    return () => {
      animation.cancel();
      preference.removeEventListener("change", stop);
    };
  }, [ref, identity, axis, distance, duration]);
}

// Progressive enhancement around View Transitions API for spatial continuity.
export function runSpatialTransition(mutate) {
  if (typeof document === "undefined" || typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    mutate();
    return;
  }
  try {
    document.startViewTransition(() => {
      flushSync(() => {
        mutate();
      });
    });
  } catch {
    mutate();
  }
}

// Preserves the last non-null value while an exit transition finishes so sheets never go blank mid-slide.
export function usePresenceValue(value, delayMs = 300) {
  const [present, setPresent] = useState(value);
  const timerRef = useRef(null);

  useEffect(() => {
    window.clearTimeout(timerRef.current);
    if (value != null) {
      setPresent(value);
      return undefined;
    }
    if (prefersReducedMotion()) {
      setPresent(null);
      return undefined;
    }
    timerRef.current = window.setTimeout(() => setPresent(null), delayMs);
    return () => window.clearTimeout(timerRef.current);
  }, [value, delayMs]);

  return value ?? present;
}
