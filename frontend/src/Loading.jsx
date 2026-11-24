import { useEffect, useRef, useState } from 'react';
import { subscribeRate, describeRate } from './rateMeter';

// The suite's shared loading animation (Claude typing at a CRT, in costume for
// the season, with rotating loading lines) from HELM's einbau-festive.js
// (auth-worker README "Seasonal decorations + the shared loading animation").
// The animation gets its own empty box — React never touches its insides — and
// `text` updates go through setText, so a changing message (e.g. invoice
// progress) can't trip React up. Plain text if the script didn't load.
//
// LEDGER's Procore usage this hour shows under it (Ben, 2026-11-19): he sweats
// and types faster as the 600 calls run low, and keels over when they're gone,
// with the time fresh ones arrive (rateMeter.js).
// `meter={false}` for the sign-in check: the rate meter is a signed-in API
// call, and polling it with an unchecked token filled HELM's Security tab with
// refused rate_status calls (2026-11-24).
export default function Loading({ text, size = 140, className = 'loading', meter = true }) {
  const ref = useRef(null);
  const loader = useRef(null);
  const festive = typeof window !== 'undefined' ? window.EinbauFestive : null;

  useEffect(() => {
    if (!festive || !ref.current) return undefined;
    loader.current = festive.loader(ref.current, { size, text });
    const unsubscribe = !meter ? () => {} : subscribeRate((status) => {
      const l = loader.current;
      const d = describeRate(status);
      if (!l || !d || typeof l.meter !== 'function') return; // an older copy of the script
      if (d.dead) {
        l.dead(d.text);
      } else {
        l.revive();
        l.strain(d.strain);
        l.meter(d.text);
      }
    });
    return () => {
      unsubscribe();
      loader.current?.remove();
      loader.current = null;
    };
    // The loader is created once per size; text changes go through setText.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [festive, size, meter]);

  useEffect(() => {
    if (loader.current && text) loader.current.setText?.(text);
  }, [text]);

  if (!festive) return <div className={className}>{text || 'Loading…'}</div>;
  return <div ref={ref} className={className} />;
}

// A seasonal loading line for busy buttons ("Working…"), picked once per
// appearance so it doesn't change on every re-render.
export function BusyLabel({ fallback = 'Working…' }) {
  const [label] = useState(() => {
    try {
      return window.EinbauFestive?.phrase?.() || fallback;
    } catch {
      return fallback;
    }
  });
  return label;
}
