import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import "./journal-exit.css";

export const JournalExitContext = createContext(null);
export const useJournalExit = () => useContext(JournalExitContext);

// Each open workspace or detail sheet owns its editor and its pending navigation.
// A second click must never run a second action under the same confirmation.
export function useJournalExitGuard(pick) {
  const status = useRef({ dirty: false, busy: false });
  const pending = useRef(null);
  const [open, setOpen] = useState(false);
  const keep = useRef(null);
  const report = useCallback((dirty, busy = false) => { status.current = { dirty, busy }; }, []);
  const mayLeave = useCallback(() => {
    if (pending.current || status.current.busy) return false;
    if (!status.current.dirty) return true;
    return new Promise(resolve => {
      pending.current = resolve;
      setOpen(true);
    });
  }, []);
  function answer(discard) {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(discard && !status.current.busy);
  }
  useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);
  const confirmation = open && (
    <AlertDialog.Root open onOpenChange={nextOpen => { if (!nextOpen) answer(false); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="journal-discard-backdrop" />
        <AlertDialog.Popup className="journal-discard-prompt" initialFocus={keep}>
          <AlertDialog.Title>{pick("放弃未保存的手账修改？", "Discard unsaved journal changes?")}</AlertDialog.Title>
          <AlertDialog.Description>{pick("这次编辑的文字和照片尚未保存。", "The photos and text from this edit have not been saved.")}</AlertDialog.Description>
          <div>
            <button type="button" className="button secondary" onClick={() => answer(true)}>{pick("放弃修改", "Discard changes")}</button>
            <button ref={keep} type="button" className="button primary" onClick={() => answer(false)}>{pick("继续编辑", "Keep editing")}</button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
  return { report, mayLeave, confirmation };
}
