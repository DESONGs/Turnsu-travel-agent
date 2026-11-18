import { Collapsible } from "@base-ui/react/collapsible";
import { CaretDown } from "@phosphor-icons/react";

export function SmoothDisclosure({
  defaultOpen = false,
  open,
  onOpenChange,
  className = "",
  summaryClassName = "",
  panelClassName = "",
  summary,
  trailingIcon = true,
  children,
}) {
  return (
    <Collapsible.Root
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className={`smooth-disclosure ${className}`}
    >
      <Collapsible.Trigger className={`smooth-disclosure-trigger ${summaryClassName}`}>
        {summary}
        {trailingIcon ? <CaretDown className="smooth-disclosure-caret" aria-hidden="true" /> : null}
      </Collapsible.Trigger>
      <Collapsible.Panel className="smooth-disclosure-panel">
        <div className={`smooth-disclosure-inner ${panelClassName}`}>{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function AnimatedCount({ value, className = "" }) {
  if (value == null || value === 0 || value === "") return null;
  return (
    <span className={`slot-count-badge ${className}`} aria-live="polite">
      <span key={String(value)} className="slot-count-digit">
        {value}
      </span>
    </span>
  );
}
