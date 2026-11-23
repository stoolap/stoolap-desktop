import * as React from "react";
import type { PopupItem } from "@/lib/native";

/**
 * On macOS the app's Select and DropdownMenu open the system's menu
 * (NSMenu: Liquid Glass on macOS 26 on) in place of the page's. Their items
 * are read from the React elements given to them; a menu holding anything
 * the system's can't show (a submenu) opens the page's as before.
 */
export const NATIVE_MENUS = typeof navigator !== "undefined" && navigator.platform.includes("Mac");

/** What opens a menu: a DropdownMenu's button, or a Select's (a combobox,
 *  with no aria-haspopup) */
const CONTROL = '[aria-haspopup], [role="combobox"]';

/** The control the pointer last went down on, and when */
let lastControl: Element | null = null;
let lastPointerAt = 0;
if (NATIVE_MENUS && typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      lastControl = (e.target as Element | null)?.closest(CONTROL) ?? null;
      lastPointerAt = performance.now();
    },
    true,
  );
}

/**
 * The control a menu opens under: the one just clicked (Radix keeps the
 * focus where it was on a click, maybe on another menu's control), else the
 * focused one (opened by keys)
 */
export function menuControl(): Element | null {
  if (lastControl && performance.now() - lastPointerAt < 1000) return lastControl;
  return document.activeElement?.closest(CONTROL) ?? lastControl;
}

/**
 * What a part of a menu is, from the mark its component carries (set in
 * select.tsx and dropdown-menu.tsx). A mark, not the component itself:
 * after a hot reload the elements on screen hold the old components
 */
export function menuRole(el: React.ReactElement): string | undefined {
  return typeof el.type === "function" ? (el.type as { menuRole?: string }).menuRole : undefined;
}

/** An element's text, its parts spaced (a two-line item reads as one line) */
export function textOf(node: React.ReactNode): string {
  const parts: string[] = [];
  const walk = (n: React.ReactNode) => {
    if (typeof n === "string" || typeof n === "number") parts.push(String(n));
    else if (Array.isArray(n)) n.forEach(walk);
    else if (React.isValidElement<{ children?: React.ReactNode }>(n)) walk(n.props.children);
  };
  walk(node);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Reads a menu's items from its elements: `read` names what an element is
 * (an item, a line, a heading), "skip" to leave it out, "unsupported" to
 * give up, or undefined to look inside it (groups, fragments, wrappers).
 * Null when given up.
 */
export function readItems(
  node: React.ReactNode,
  read: (el: React.ReactElement<Record<string, unknown>>) => PopupItem | "skip" | "unsupported" | undefined,
): PopupItem[] | null {
  const items: PopupItem[] = [];
  let ok = true;
  const walk = (n: React.ReactNode) => {
    React.Children.forEach(n, (child) => {
      if (!ok || !React.isValidElement<Record<string, unknown>>(child)) return;
      const item = read(child);
      if (item === "unsupported") ok = false;
      else if (item === "skip") return;
      else if (item) items.push(item);
      else walk(child.props.children as React.ReactNode);
    });
  };
  walk(node);
  return ok ? items : null;
}
