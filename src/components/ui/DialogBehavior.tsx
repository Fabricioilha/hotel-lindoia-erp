import { useEffect } from 'react';

// Sole owner of body scroll locking, including nested dialogs and route changes.
// Individual dialogs must not save/restore overflow: their cleanup order can
// otherwise restore another dialog's 'hidden' value after every dialog closes.
// Also handles shared keyboard and unsaved-form behavior.
export function DialogBehavior() {
  useEffect(() => {
    let active: HTMLElement | null = null;
    let trigger: HTMLElement | null = null;
    let dirty = false;
    let overflow = '';
    const controls = () => active ? Array.from(active.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true') : [];
    const synchronize = () => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).filter((element) => element.getClientRects().length > 0);
      const next = dialogs.at(-1) ?? null;
      if (next === active) return;
      if (!active && next) { trigger = document.activeElement as HTMLElement; overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
      const previous = active; active = next; dirty = false;
      if (next) { if (!next.contains(document.activeElement)) (controls()[0] ?? next).focus(); }
      else if (previous) { document.body.style.overflow = overflow; if (trigger?.isConnected) trigger.focus(); }
    };
    const confirmDiscard = () => {
      if (!dirty || window.confirm('Descartar as alterações ainda não salvas deste formulário?')) { dirty = false; return true; }
      return false;
    };
    const change = (event: Event) => { if (event.target instanceof Element && active?.contains(event.target) && event.target.closest('[data-guard-unsaved]')) dirty = true; };
    const closeButton = () => controls().find((element) => element.tagName === 'BUTTON' && /^fechar|^cancelar/i.test(element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''));
    const keydown = (event: KeyboardEvent) => {
      if (!active) return;
      if (event.key === 'Escape') {
        const close = closeButton();
        if (!close) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (confirmDiscard()) close.click();
      }
      if (event.key === 'Tab') {
        const list = controls(); const first = list[0]; const last = list.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (!active.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      }
    };
    const dismiss = (event: MouseEvent) => {
      if (!active || !(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      const isClose = event.type === 'click' && button && active.contains(button) && /^fechar|^cancelar/i.test(button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '');
      const isBackdrop = event.type === 'mousedown' && event.target === active.parentElement;
      if ((isClose || isBackdrop) && !confirmDiscard()) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    const saved = () => { dirty = false; };
    const observer = new MutationObserver(synchronize);
    observer.observe(document.body, { childList: true, subtree: true }); synchronize();
    document.addEventListener('keydown', keydown, true); document.addEventListener('input', change, true); document.addEventListener('change', change, true);
    document.addEventListener('click', dismiss, true); document.addEventListener('mousedown', dismiss, true); window.addEventListener('beforeunload', unload); window.addEventListener('app:form-saved', saved);
    return () => { observer.disconnect(); document.removeEventListener('keydown', keydown, true); document.removeEventListener('input', change, true); document.removeEventListener('change', change, true); document.removeEventListener('click', dismiss, true); document.removeEventListener('mousedown', dismiss, true); window.removeEventListener('beforeunload', unload); window.removeEventListener('app:form-saved', saved); if (active) document.body.style.overflow = overflow; };
  }, []);
  return null;
}
