import { useEffect, useRef, useState } from "react";

// The suite's shared loading animation (Claude typing at a CRT, in costume for
// the season, with rotating loading lines) from HELM's einbau-festive.js
// (auth-worker README "Seasonal decorations + the shared loading animation").
// The animation gets its own empty box — React never touches its insides — and
// `text` updates go through setText, so a changing message (e.g. invoice
// progress) can't trip React up. Plain text if the script didn't load.
export default function Loading({ text, size = 140, className = "empty-state" }) {
  const ref = useRef(null);
  const loader = useRef(null);
  const festive = typeof window !== 'undefined' ? window.EinbauFestive : null;

  useEffect(() => {
    if (!festive || !ref.current) return undefined;
    loader.current = festive.loader(ref.current, { size, text });
    return () => {
      loader.current?.remove();
      loader.current = null;
    };
    // The loader is created once per size; text changes go through setText.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [festive, size]);

  useEffect(() => {
    if (loader.current && text) loader.current.setText?.(text);
  }, [text]);

  if (!festive) return <div className={className}>{text || "Loading…"}</div>;
  return <div ref={ref} className={className} />;
}

// A seasonal loading line for busy buttons ("Working…"), picked once per
// appearance so it doesn't change on every re-render.
export function BusyLabel({ fallback = "Working…" }) {
  const [label] = useState(() => {
    try {
      return window.EinbauFestive?.phrase?.() || fallback;
    } catch {
      return fallback;
    }
  });
  return label;
}
