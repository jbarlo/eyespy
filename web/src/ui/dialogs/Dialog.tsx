/** A modal <dialog>; its children mount only while open (so each opening starts with fresh state). */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function Dialog({
  open,
  label,
  children,
  onClose,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly children: ReactNode;
  readonly onClose?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal focuses the first focusable element, which may be an info "?" that would show a focus ring and open
      // its popover on Enter. Start on the dialog's first action instead, or on the element marked data-initial-focus
      // (for a dialog whose text has links before its action)
      const initial = d.querySelector<HTMLElement>("[data-initial-focus]");
      if (initial) initial.focus({ preventScroll: true });
      else if (document.activeElement instanceof HTMLElement && document.activeElement.matches("button.info"))
        d.querySelector<HTMLElement>(".actions button")?.focus({ preventScroll: true });
      // and open at the top even when that focus scrolled a tall dialog (Settings on a phone)
      d.scrollTo({ top: 0 });
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
    >
      {open && children}
    </dialog>
  );
}
