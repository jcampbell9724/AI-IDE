import { buildRobustSelector } from "@browser-agent/shared/browser-selector";

// Runs in an isolated world so the preview cannot replace the picker callbacks.
export function elementPickerScript(): string {
  return `new Promise((resolve) => {
    globalThis.__spanCancelPicker?.();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-browser-agent-temporary', 'picker');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6366f1;background:rgba(99,102,241,.14);display:none;box-sizing:border-box';
    document.documentElement.appendChild(overlay);
    const selectorFor = (${buildRobustSelector.toString()});
    const finish = (value) => {
      overlay.remove();
      window.removeEventListener('pointermove', hover, true);
      window.removeEventListener('click', select, true);
      window.removeEventListener('pointerdown', block, true);
      window.removeEventListener('pointerup', block, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pagehide', cancel, true);
      clearTimeout(timer);
      delete globalThis.__spanCancelPicker;
      resolve(value);
    };
    const cancel = () => finish(null);
    const block = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const hover = (event) => {
      const element = event.composedPath().find(item => item instanceof Element);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      Object.assign(overlay.style, { display:'block', left:rect.x+'px', top:rect.y+'px', width:rect.width+'px', height:rect.height+'px' });
    };
    const select = (event) => {
      block(event);
      const element = event.composedPath().find(item => item instanceof Element);
      if (!element) return;
      const password = element.matches('input[type="password"]');
      finish({ url: location.href, selector: selectorFor(element, document), tagName: element.tagName.toLowerCase(), text: password ? '' : (element.innerText || element.textContent || '').trim().slice(0, 1000) });
    };
    const key = (event) => { if (event.key === 'Escape') { block(event); cancel(); } };
    const timer = setTimeout(cancel, 120000);
    globalThis.__spanCancelPicker = cancel;
    window.addEventListener('pointermove', hover, true);
    window.addEventListener('pointerdown', block, true);
    window.addEventListener('pointerup', block, true);
    window.addEventListener('click', select, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('pagehide', cancel, true);
  })`;
}
