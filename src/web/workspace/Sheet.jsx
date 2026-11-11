import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import { Icon } from "./Icon.jsx";

export function Sheet({ title, context, children, footer, onClose, busy = false, wide = false, className: extra = "" }) {
  const root = useRef(null), close = useRef(onClose), locked = useRef(busy);
  close.current = onClose; locked.current = busy;
  useEffect(() => {
    const previous = document.activeElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.current?.querySelector("h2")?.focus({ preventScroll: true });
    const keys = event => {
      if (event.key === "Escape" && !locked.current) { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const targets = [...root.current.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')]
        .filter(node => !node.hidden && node.getClientRects().length);
      if (!targets.length) { event.preventDefault(); return; }
      const index = targets.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); targets.at(-1).focus(); }
      else if (!event.shiftKey && (index < 0 || index === targets.length - 1)) { event.preventDefault(); targets[0].focus(); }
    };
    document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("keydown", keys); document.body.style.overflow = oldOverflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div className={`ui-sheet-backdrop ${wide ? "wide" : ""}`} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={root} className={`ui-sheet ${extra}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="ui-sheet-header"><div><h2 tabIndex={-1}>{title}</h2>{context && <p>{context}</p>}</div><button className="ui-icon-button" type="button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><Icon name="X" /></button></header>
      <div className="ui-sheet-body">{children}</div>{footer && <footer className="ui-sheet-footer">{footer}</footer>}
    </section>
  </div>, document.body);
}

export function ConfirmInline({ title, description, cancel = "继续编辑", action = "放弃未保存内容", onCancel, onConfirm, busy = false }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <div className="ui-confirm" role="group" aria-label={title}><strong ref={heading} tabIndex={-1}>{title}</strong>{description && <p>{description}</p>}<div className="ui-actions"><button className="ui-secondary" type="button" disabled={busy} onClick={onCancel}>{cancel}</button><button className="ui-danger" type="button" disabled={busy} onClick={onConfirm}>{action}</button></div></div>;
}
