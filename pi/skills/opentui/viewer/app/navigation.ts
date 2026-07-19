import { createSignal } from 'solid-js';

export type View = 'selection' | 'detail' | 'span';
export type Modal = 'filter' | 'sort';

export function createNavigation() {
  const [views, setViews] = createSignal<View[]>(['selection']);
  const [modals, setModals] = createSignal<Modal[]>([]);
  return {
    views, modals,
    view: () => views().at(-1)!,
    modal: () => modals().at(-1) ?? 'none',
    pushView: (view: View) => setViews(stack => stack.at(-1) === view ? stack : [...stack, view]),
    popView: () => setViews(stack => stack.length > 1 ? stack.slice(0, -1) : stack),
    pushModal: (modal: Modal) => setModals(stack => [...stack.filter(item => item !== modal), modal]),
    popModal: () => setModals(stack => stack.slice(0, -1)),
    esc: () => { if (modals().length) { setModals(stack => stack.slice(0, -1)); return true; } if (views().length > 1) { setViews(stack => stack.slice(0, -1)); return true; } return false; },
  };
}
