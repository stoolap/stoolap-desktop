import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { toast } from "sonner";
import i18n from "./i18n";
export { quoteId } from "./sql-utils";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Extract error message from any thrown value (Error, string, or unknown). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return i18n.t("common:errors.unknown");
}

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // @ts-expect-error -- userAgentData is not yet in all TS lib typings
  const uaData = navigator.userAgentData as { platform?: string } | undefined;
  if (uaData?.platform) return uaData.platform === "macOS";
  return navigator.userAgent?.includes("Mac") ?? false;
}

export function modKey(): string {
  return isMac() ? "\u2318" : "Ctrl";
}

/** Ask where to save, write the file, and say where it went (or why not). */
export async function saveFile(content: string, filename: string, _mime: string) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");

  const ext = filename.split(".").pop() || "*";
  const path = await save({
    defaultPath: filename,
    filters: [{ name: i18n.t("common:fileTypes.ext", { ext: ext.toUpperCase() }), extensions: [ext] }],
  });
  if (!path) return;
  try {
    await writeTextFile(path, content);
    toast.success(i18n.t("common:save.saved", { name: basename(path) }), { description: path });
  } catch (e) {
    toast.error(i18n.t("common:save.failed", { name: basename(path) }), { description: errorMessage(e) });
  }
}

export function escapeCSV(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/** Last component of a file path, with either separator (Windows uses `\`). */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** onWheel for a row that only scrolls sideways: a mouse wheel turns up and
 * down, so its turn moves the row across. A sideways swipe scrolls it as is. */
export function scrollSideways(e: React.WheelEvent<HTMLElement>) {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
}

/**
 * `text` cut in the middle to the most of it that `fits`, as Finder does: the
 * end keeps at least 7 characters, which often tell similar names apart
 * (orders_2025, orders_2026), and the start gives way with "…".
 */
export function middleCut(text: string, fits: (s: string) => boolean): string {
  if (fits(text)) return text;
  const cut = (kept: number) => {
    const tail = Math.min(kept, Math.max(Math.ceil(kept / 2), 7));
    return text.slice(0, kept - tail) + "…" + text.slice(text.length - tail);
  };
  // The most characters kept that still fit (at least one)
  let lo = 1;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cut(mid))) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}
