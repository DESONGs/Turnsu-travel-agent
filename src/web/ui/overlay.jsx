import { useRef } from "react";
import { Dialog } from "@base-ui/react/dialog";

export function OverlaySurface({
  children,
  onClose,
  overlayClassName,
  surfaceClassName,
  labelledBy,
  label,
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef = null,
}) {
  const portalContainerRef = useRef(null);

  const handleOpenChange = (open, eventDetails) => {
    if (open) return;
    if (eventDetails.reason === "escape-key" && !closeOnEscape) {
      eventDetails.cancel();
      return;
    }
    if (eventDetails.reason === "outside-press" && !closeOnBackdrop) {
      eventDetails.cancel();
      return;
    }
    onClose?.();
  };

  return <Dialog.Root open modal disablePointerDismissal={!closeOnBackdrop} onOpenChange={handleOpenChange}>
    <div ref={portalContainerRef} className="overlay-portal-anchor" />
    <Dialog.Portal container={portalContainerRef}>
      <Dialog.Viewport className={overlayClassName}>
        <Dialog.Popup className={surfaceClassName} aria-labelledby={labelledBy} aria-label={label} initialFocus={initialFocusRef || true}>
          {children}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}
