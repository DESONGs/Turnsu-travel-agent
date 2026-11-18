import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";

function useIsMobileSheetViewport(open) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? Boolean(window.matchMedia?.("(max-width: 720px)")?.matches) : false,
  );
  useEffect(() => {
    // Drawer and Dialog have different roots. Switching while one is open
    // would remount the contents and discard local edits or a loaded drawing.
    if (open || typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(max-width: 720px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [open]);
  return isMobile;
}

export function OverlaySurface({
  open = true,
  placement = "center",
  mobileBottomSheet = false,
  modal = true,
  children,
  onClose,
  onOpenChangeComplete,
  overlayClassName = "",
  surfaceClassName = "",
  labelledBy,
  label,
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef = null,
}) {
  const portalContainerRef = useRef(null);
  const isMobile = useIsMobileSheetViewport(mobileBottomSheet && open);

  const handleOpenChange = (nextOpen, eventDetails) => {
    if (nextOpen) return;
    if (eventDetails?.reason === "escape-key" && !closeOnEscape) {
      eventDetails.cancel?.();
      return;
    }
    if (eventDetails?.reason === "outside-press" && !closeOnBackdrop) {
      eventDetails.cancel?.();
      return;
    }
    onClose?.();
  };

  if (mobileBottomSheet && isMobile) {
    return (
      <Drawer.Root
        open={open}
        modal={modal}
        swipeDirection="down"
        disablePointerDismissal={!closeOnBackdrop}
        onOpenChange={handleOpenChange}
        onOpenChangeComplete={onOpenChangeComplete}
      >
        <div ref={portalContainerRef} className="overlay-portal-anchor" />
        <Drawer.Portal container={portalContainerRef}>
          {modal ? <Drawer.Backdrop className="travel-overlay-backdrop" data-placement="bottom" /> : null}
          <Drawer.Viewport className={`travel-overlay-viewport ${overlayClassName}`} data-placement="bottom">
            <Drawer.Popup
              className={`travel-overlay-popup travel-mobile-bottom-sheet ${surfaceClassName}`}
              data-placement="bottom"
              aria-labelledby={labelledBy}
              aria-label={label}
              initialFocus={initialFocusRef || true}
            >
              <div className="sheet-grab-bar" aria-hidden="true">
                <span />
              </div>
              <Drawer.Content className="sheet-drawer-body">{children}</Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <Dialog.Root
      open={open}
      modal={modal}
      disablePointerDismissal={!closeOnBackdrop}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <div ref={portalContainerRef} className="overlay-portal-anchor" />
      <Dialog.Portal container={portalContainerRef}>
        {modal ? <Dialog.Backdrop className="travel-overlay-backdrop" data-placement={placement} /> : null}
        <Dialog.Viewport className={`travel-overlay-viewport ${overlayClassName}`} data-placement={placement}>
          <Dialog.Popup
            className={`travel-overlay-popup ${surfaceClassName}`}
            data-placement={placement}
            aria-labelledby={labelledBy}
            aria-label={label}
            initialFocus={initialFocusRef || true}
          >
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
