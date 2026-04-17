import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";

// Platform detection for platform-specific CSS (vibrancy, etc.)
if (navigator.platform.includes("Mac")) {
  document.documentElement.dataset.platform = "mac";
}

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

  // Store the raw hex for mode switches
  root.dataset.accentHex = hex;
}

// Apply immediately
applySystemTheme();

// Read system accent color and apply
import { getAccentColor, onAccentColorChanged, initNotifications } from "@/lib/native";
getAccentColor().then(applyAccentColor);

// Request notification permission at startup (non-blocking)
initNotifications();

// Listen for system theme changes
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applySystemTheme);

// Listen for system accent color changes
onAccentColorChanged(applyAccentColor);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
