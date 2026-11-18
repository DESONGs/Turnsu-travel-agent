import { useEffect, useRef } from "react";
import { riffle } from "@lucasmarkes/hairline";

export function HairlineIllustration() {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    const figure = riffle(node, { intensity: 0.25, theme: "light" });
    node.tabIndex = -1;
    return () => figure.destroy();
  }, []);
  return <div className="travel-line-illustration" aria-hidden="true">
    <div ref={ref} style={{ aspectRatio: "5 / 4" }} />
  </div>;
}
