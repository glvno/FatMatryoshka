// SPDX-License-Identifier: GPL-3.0-only
const anchors = new WeakMap<HTMLElement, HTMLElement>();

/** Keep a top-layer menu on screen, including inside a scrolled or zoomed patch. */
export function positionPopover(panel: HTMLElement, anchor: HTMLElement): void {
  anchors.set(panel, anchor);
  const a = anchor.getBoundingClientRect();
  const margin = 12;
  panel.style.maxHeight = `${Math.max(120, window.innerHeight - margin * 2)}px`;
  const r = panel.getBoundingClientRect();
  const left = Math.max(margin, Math.min(a.right - r.width, window.innerWidth - r.width - margin));
  const below = a.bottom + 6;
  const top = below + r.height <= window.innerHeight - margin ? below : Math.max(margin, a.top - r.height - 6);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/** Reposition open parameter menus after viewport changes. */
export function setupPopoverPositioning(): void {
  const reposition = (): void => {
    for (const panel of document.querySelectorAll<HTMLElement>('[popover]:popover-open')) {
      const anchor = anchors.get(panel);
      if (anchor?.isConnected) positionPopover(panel, anchor);
    }
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
}
