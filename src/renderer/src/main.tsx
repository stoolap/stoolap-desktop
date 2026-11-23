import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { followLanguage, initI18n } from "@/lib/i18n";
import "./globals.css";

// Platform detection for platform-specific CSS (vibrancy, etc.)
if (navigator.platform.includes("Mac")) {
  document.documentElement.dataset.platform = "mac";
} else if (navigator.platform.includes("Win")) {
  document.documentElement.dataset.platform = "windows";
}

// No browser menu (Back, Reload, Inspect…) on a right-click: the app shows
// its own where it has one. Text fields keep theirs, for copy and paste.
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable], .cm-editor, .allow-select")) return;
  e.preventDefault();
});

// Follow system dark/light mode
function applySystemTheme() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
  // Re-apply accent color for the new mode
  const stored = document.documentElement.dataset.accentHex;
  if (stored) applyAccentColor(stored);
}

// Apply system accent color to CSS custom properties
function applyAccentColor(hex: string) {
  // hex is like "007affff" (RGBA) — extract RGB
  const rgb = hex.slice(0, 6);
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);

  // Lighter variant for dark mode (mix 30% with white)
  const lr = Math.min(255, r + Math.round((255 - r) * 0.3));
  const lg = Math.min(255, g + Math.round((255 - g) * 0.3));
  const lb = Math.min(255, b + Math.round((255 - b) * 0.3));
  const darkHex = `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;

  const isDark = document.documentElement.classList.contains("dark");
  const color = isDark ? darkHex : `#${rgb}`;

  const root = document.documentElement;
  root.style.setProperty("--primary", color);
  root.style.setProperty("--ring", color);
  root.style.setProperty("--sidebar-primary", color);
  root.style.setProperty("--sidebar-ring", color);
  root.style.setProperty("--chart-1", color);
  // As the system has it, for the tint of macOS's sidebar glass
  root.style.setProperty("--system-accent", `#${rgb}`);

  // Store the raw hex for mode switches
  root.dataset.accentHex = hex;
}

// Apply immediately
applySystemTheme();

// Read system accent color and apply
import { getAccentColor, getMacosVersion, onAccentColorChanged, initNotifications } from "@/lib/native";
getAccentColor().then(applyAccentColor);

// Request notification permission at startup (non-blocking)
initNotifications();

// Listen for system theme changes
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applySystemTheme);

// Listen for system accent color changes
onAccentColorChanged(applyAccentColor);

// About is a window of its own on the same page (outside macOS)
const label = getCurrentWindow().label;

// The app loads once the translations have, so its stores and first frame
// are already in the user's language; and once macOS's version is known, which
// sets the window's layout (data-macos, read by the app shell)
Promise.all([
  initI18n().catch(() => {}),
  getMacosVersion()
    .then((v) => { document.documentElement.dataset.macos = String(v); })
    .catch(() => {}),
])
  .then(() => {
    followLanguage();
    return label === "main"
      ? import("./App").then(({ default: App }) => <App />)
      : import("./components/windows/panel-window").then(({ PanelWindow }) => <PanelWindow />);
  })
  .then((page) =>
    ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{page}</React.StrictMode>),
  );
