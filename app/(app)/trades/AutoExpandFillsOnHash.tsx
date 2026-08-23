'use client';

import { useEffect } from 'react';

/**
 * Module 02 Slice 7b — closes the deep-link gap `GroupingChip.tsx`'s own
 * header (Slice 7a) flagged: opening/scrolling to a trade's fills
 * (`<details id="trade-<id>">`, see `page.tsx`'s `TradeFillsSection`) from
 * either a same-page anchor click (`GroupingChip`'s own "Separate" link)
 * or a cross-page deep link (the close-out screen's "which trade is
 * blocking" links, `/trades#trade-<id>`, `close-out/ConfirmDayForm.tsx`).
 *
 * Native `<details>` is not reliably auto-opened by every browser just
 * because a URL fragment targets content inside it — this is a small,
 * generic client-side assist rather than relying on unguaranteed browser
 * behaviour. Rendered once, with no props, at the top of the trade list
 * page: it reads whatever `id` is currently in `location.hash`, so it
 * works for every trade's `<details>` on the page without per-trade
 * wiring, and re-runs on `hashchange` for a same-page anchor click too
 * (not just the initial cross-page-navigation case).
 */
export function AutoExpandFillsOnHash() {
  useEffect(() => {
    function openAndScroll() {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      const el = document.getElementById(hash);
      if (!el) return;
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    openAndScroll();
    window.addEventListener('hashchange', openAndScroll);
    return () => window.removeEventListener('hashchange', openAndScroll);
  }, []);

  return null;
}
