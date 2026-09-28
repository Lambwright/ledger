// Personal accent override, set once in HELM ("My Account" → Appearance) and
// carried on every Einbau ID user record as `themeAccent`. Every suite app
// applies it the same way: same preset table, same three CSS custom
// properties each app's own stylesheet already defines on :root. Per-user,
// server-side — Alfonso choosing a color never touches anyone else's session.
// Kept in sync with the other apps' copies (HELM/TALLY/HANDOFF accentPresets.js).
export const ACCENT_PRESETS = [
  { id: "tungsten", label: "Tungsten", accent: "#9BA8B5", accentDark: "#7A8794", rgb: "155, 168, 181" },
  { id: "amber", label: "Amber", accent: "#D1A93F", accentDark: "#A6842F", rgb: "209, 169, 63" },
  { id: "crimson", label: "Crimson", accent: "#D14343", accentDark: "#A63333", rgb: "209, 67, 67" },
  { id: "forest", label: "Forest", accent: "#6FB35C", accentDark: "#559244", rgb: "111, 179, 92" },
  { id: "violet", label: "Violet", accent: "#9B7ED1", accentDark: "#7C5FA8", rgb: "155, 126, 209" },
  { id: "teal", label: "Teal", accent: "#3F9EA0", accentDark: "#2F7B7D", rgb: "63, 158, 160" },
  { id: "rose", label: "Rose", accent: "#D1618F", accentDark: "#A64A70", rgb: "209, 97, 143" },
  { id: "indigo", label: "Indigo", accent: "#6C7BD1", accentDark: "#55639F", rgb: "108, 123, 209" },
  { id: "copper", label: "Copper", accent: "#C97D4F", accentDark: "#A2623C", rgb: "201, 125, 79" },
];

export function applyAccentPreset(presetId) {
  const preset = ACCENT_PRESETS.find((p) => p.id === presetId);
  const root = document.documentElement.style;
  if (!preset) {
    root.removeProperty("--accent");
    root.removeProperty("--accent-dark");
    root.removeProperty("--accent-rgb");
    return;
  }
  root.setProperty("--accent", preset.accent);
  root.setProperty("--accent-dark", preset.accentDark);
  root.setProperty("--accent-rgb", preset.rgb);
}
