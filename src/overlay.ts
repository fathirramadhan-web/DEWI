import type { Page } from '@playwright/test';

export type CameraView = {
  tx: number;
  ty: number;
  scale: number;
};

export type DewiOverlayApi = {
  keys(combo: string | null): void;
  visible(on: boolean): void;
  cursorAt(x: number, y: number): void;
  drag(on: boolean): void;
  zoom(px: number, py: number, scale: number, ms: number): CameraView;
  setInstantView(tx: number, ty: number, scale: number): void;
};

declare global {
  interface Window {
    __dewi?: DewiOverlayApi;
  }
}

function injectOverlayScript(): void {
  const ROOT_ID = 'dewi-overlay';

  const stylesheet = `
#${ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  contain: layout style;
}
#${ROOT_ID}[data-hidden='true'] {
  display: none;
}
#${ROOT_ID} .dewi-cursor {
  position: absolute;
  top: 0;
  left: 0;
  width: 26px;
  height: 26px;
  margin: -2.2px 0 0 -5px;
  transform-origin: 5px 2.2px;
  will-change: translate, scale;
  translate: -100px -100px;
  transition: scale 120ms cubic-bezier(0.2, 0, 0.2, 1);
  scale: 1;
}
#${ROOT_ID}[data-press='true'] .dewi-cursor {
  scale: 0.86;
}
#${ROOT_ID} .dewi-cursor svg {
  display: block;
  overflow: visible;
}
#${ROOT_ID} .dewi-drag-ring {
  position: absolute;
  top: 0;
  left: 0;
  width: 34px;
  height: 34px;
  margin: -17px 0 0 -17px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.22);
  border: 1.5px solid rgba(99, 102, 241, 0.72);
  opacity: 0;
  will-change: translate, opacity;
  transition: opacity 140ms ease;
}
#${ROOT_ID}[data-drag='true'] .dewi-drag-ring {
  opacity: 1;
}
#${ROOT_ID} .dewi-key-dock {
  position: absolute;
  left: 50%;
  bottom: 34px;
  translate: -50% 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}
#${ROOT_ID} .dewi-keys {
  display: flex;
  gap: 6px;
  opacity: 0;
  translate: 0 6px;
  transition: opacity 120ms ease, translate 160ms cubic-bezier(0.2, 0, 0.2, 1);
}
#${ROOT_ID} .dewi-keys[data-on='true'] {
  opacity: 1;
  translate: 0 0;
}
#${ROOT_ID} .dewi-keys kbd {
  min-width: 34px;
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 15px;
  font-weight: 560;
  line-height: 1;
  text-align: center;
  color: #f8fafc;
  background: rgba(15, 18, 26, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-bottom-color: rgba(0, 0, 0, 0.6);
  box-shadow: 0 6px 18px -6px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(8px);
}
`;

  const cursorSvg = `
<svg width="26" height="26" viewBox="0 0 26 26" fill="none">
  <path d="M5 2.2 5 20.4 9.9 15.9 13.1 23.4 16.4 22 13.2 14.6 20 14.2Z"
        fill="#ffffff" stroke="rgba(0,0,0,0.58)" stroke-width="1.3"
        stroke-linejoin="round"/>
</svg>`;

  function mountOverlay(): void {
    if (document.getElementById(ROOT_ID)) {
      return;
    }

    const styleEl = document.createElement('style');
    styleEl.textContent = stylesheet;

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="dewi-drag-ring"></div>
      <div class="dewi-cursor">${cursorSvg}</div>
      <div class="dewi-key-dock">
        <div class="dewi-keys"></div>
      </div>`;

    document.documentElement.append(styleEl, root);

    const cursorEl = root.querySelector('.dewi-cursor') as HTMLElement;
    const dragRingEl = root.querySelector('.dewi-drag-ring') as HTMLElement;
    const keysEl = root.querySelector('.dewi-keys') as HTMLElement;

    const movePointer = (x: number, y: number): void => {
      const coords = `${x}px ${y}px`;
      cursorEl.style.translate = coords;
      dragRingEl.style.translate = coords;
    };

    addEventListener(
      'mousemove',
      (ev) => movePointer(ev.clientX, ev.clientY),
      { capture: true, passive: true }
    );
    addEventListener(
      'mousedown',
      () => {
        root.dataset.press = 'true';
      },
      { capture: true, passive: true }
    );
    addEventListener(
      'mouseup',
      () => {
        root.dataset.press = 'false';
      },
      { capture: true, passive: true }
    );

    const api: DewiOverlayApi = {
      keys(combo: string | null) {
        if (!combo) {
          keysEl.dataset.on = 'false';
          return;
        }
        keysEl.replaceChildren(
          ...combo.split('+').map((part) => {
            const kbd = document.createElement('kbd');
            kbd.textContent = part;
            return kbd;
          })
        );
        keysEl.dataset.on = 'true';
      },
      visible(on: boolean) {
        root.dataset.hidden = on ? 'false' : 'true';
      },
      cursorAt(x: number, y: number) {
        movePointer(x, y);
      },
      drag(on: boolean) {
        root.dataset.drag = on ? 'true' : 'false';
      },
      zoom(px: number, py: number, scale: number, ms: number): CameraView {
        const body = document.body;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const extra = scale - 1;

        const tx = Math.min(0, Math.max(-extra * vw, vw / 2 - scale * px));
        const ty = Math.min(0, Math.max(-extra * vh, vh / 2 - scale * py));

        body.style.willChange = 'transform';
        body.style.transformOrigin = '0 0';
        body.style.transition = `transform ${ms}ms cubic-bezier(0.33, 0, 0.22, 1)`;
        body.style.transform =
          scale === 1 ? 'none' : `translate(${tx}px, ${ty}px) scale(${scale})`;

        body.addEventListener(
          'transitionend',
          () => {
            body.style.willChange = 'auto';
          },
          { once: true }
        );

        return scale === 1 ? { tx: 0, ty: 0, scale: 1 } : { tx, ty, scale };
      },
      setInstantView(tx: number, ty: number, scale: number) {
        const body = document.body;
        body.style.transition = 'none';
        body.style.willChange = 'auto';
        body.style.transformOrigin = '0 0';
        body.style.transform =
          scale === 1 ? 'none' : `translate(${tx}px, ${ty}px) scale(${scale})`;
        void body.offsetHeight;
      },
    };

    window.__dewi = api;
  }

  if (document.documentElement) {
    mountOverlay();
  } else {
    addEventListener('DOMContentLoaded', mountOverlay, { once: true });
  }
  addEventListener('DOMContentLoaded', mountOverlay);
}

export async function installOverlay(page: Page): Promise<void> {
  await page.addInitScript(injectOverlayScript);
}
