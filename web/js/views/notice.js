import { el } from '../state.js';

/** The one-line status message under the composer. */
export function notice(text) {
  el('notice').textContent = text;
  if (!text) return;
  setTimeout(() => {
    if (el('notice').textContent === text) el('notice').textContent = '';
  }, 6000);
}
