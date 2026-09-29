import { createContext, useContext, useMemo } from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";

// Structural wrapper adapted from shadcn/ui's Base UI drawer implementation.
// Travel Agent owns the visual layer so the primitive can share the product tokens.
const TravelDrawerContext = createContext(null);

function useTravelDrawer() {
  const value = useContext(TravelDrawerContext);
  if (!value) throw new Error("TravelDrawer parts must be used inside TravelDrawer.Root");
  return value;
}

function Root({ modal = true, snapPoints, swipeDirection = "down", ...props }) {
  const value = useMemo(() => ({ hasSnapPoints: Boolean(snapPoints?.length), modal, swipeDirection }), [modal, snapPoints, swipeDirection]);
  return <TravelDrawerContext.Provider value={value}>
    <DrawerPrimitive.Root data-slot="travel-drawer" modal={modal} snapPoints={snapPoints} swipeDirection={swipeDirection} {...props} />
  </TravelDrawerContext.Provider>;
}

function Surface({ children, handle = null, className = "", ...props }) {
  const { hasSnapPoints, modal, swipeDirection } = useTravelDrawer();
  return <DrawerPrimitive.Portal>
    {modal === true ? <DrawerPrimitive.Backdrop className="drawer-backdrop" /> : null}
    <DrawerPrimitive.Viewport className="drawer-viewport" data-modal={modal}>
      <DrawerPrimitive.Popup className={`travel-drawer-popup ${className}`} data-snap-points={hasSnapPoints ? "" : undefined} data-swipe-direction={swipeDirection} {...props}>
        {handle}
        <DrawerPrimitive.Content className="travel-drawer-content">{children}</DrawerPrimitive.Content>
      </DrawerPrimitive.Popup>
    </DrawerPrimitive.Viewport>
  </DrawerPrimitive.Portal>;
}

export const TravelDrawer = {
  Root,
  Surface,
  Trigger: DrawerPrimitive.Trigger,
  Close: DrawerPrimitive.Close,
  Title: DrawerPrimitive.Title,
  Description: DrawerPrimitive.Description,
  VirtualKeyboardProvider: DrawerPrimitive.VirtualKeyboardProvider,
};
