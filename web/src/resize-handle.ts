// SPDX-License-Identifier: GPL-3.0-only
interface ResizeEvents {
  start(): void;
  size(): { width: number; height: number };
  resize(width: number, height: number): void;
  end(): void;
}

/** Pointer and keyboard resizing share the same layout/history transaction. */
export function resizeHandle(label: string, zoom: () => number, events: ResizeEvents): HTMLButtonElement {
  const handle = document.createElement('button');
  handle.className = 'resize-handle';
  handle.setAttribute('aria-label', label);
  handle.title = `${label}: drag, or use arrow keys (Shift for larger steps)`;
  handle.textContent = '◢';
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    events.start();
    const initial = events.size(), scale = zoom();
    handle.setPointerCapture(e.pointerId);
    const move = (next: PointerEvent): void => events.resize(initial.width + (next.clientX - e.clientX) / scale, initial.height + (next.clientY - e.clientY) / scale);
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('lostpointercapture', end);
      events.end();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', end);
  });
  handle.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    events.start();
    const { width, height } = events.size(), step = e.shiftKey ? 40 : 10;
    events.resize(width + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0), height + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0));
    events.end();
  });
  return handle;
}
