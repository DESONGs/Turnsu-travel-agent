import { useEffect, useState } from "react";
import { api } from "./api-client.js";

export function AuthenticatedMapImage({ tripId, alt, onError, ...props }) {
  const desktop = typeof window !== "undefined" && Boolean(window.travelDesktop || window.travelHost);
  const [source, setSource] = useState(desktop ? null : api.mapUrl(tripId));
  useEffect(() => {
    if (!desktop) {
      setSource(api.mapUrl(tripId));
      return undefined;
    }
    const controller = new AbortController();
    let objectUrl = null;
    api.mapBlob(tripId, controller.signal).then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch((error) => {
      if (error?.name !== "AbortError") onError?.(error);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [desktop, tripId]);
  return source ? <img {...props} src={source} alt={alt} onError={onError} /> : <span className="authenticated-map-loading" role="status">正在载入地图</span>;
}
