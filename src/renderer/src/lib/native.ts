/**
 * Native platform adapter — replaces Electron's window.api with Tauri invoke/listen.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  open,
  save,
  confirm,
} from "@tauri-apps/plugin-dialog";
import { setNativeMenuOpen } from "@/components/ui/tooltip";
import { showPageContextMenu } from "@/components/layout/page-context-menu";
import { getVersion as tauriGetVersion } from "@tauri-apps/api/app";
import i18n from "./i18n";

// --- Dialogs ---

export async function showOpenDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: true,
    title: i18n.t("common:native.openDatabase"),
  });
  return typeof selected === "string" ? selected : null;
}

export async function showSaveDialog(
  defaultName: string,
): Promise<string | null> {
  const result = await save({
    defaultPath: defaultName,
    filters: [
      { name: i18n.t("common:fileTypes.sql"), extensions: ["sql"] },
      { name: i18n.t("common:fileTypes.all"), extensions: ["*"] },
    ],
  });
  return result ?? null;
}

export async function showConfirmDialog(options: {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  // macOS's alerts are headed by the question itself, the detail below it
  // (the action's name is on the button already); elsewhere the title is
  // the window's, so it stays the action's name and the question goes below
  if (navigator.platform.includes("Mac")) {
    return confirm(options.detail ?? "", {
      title: options.message,
      okLabel: options.confirmLabel || i18n.t("common:native.ok"),
      cancelLabel: i18n.t("common:native.cancel"),
      kind: options.destructive ? "warning" : "info",
    });
  }
  return confirm(
    options.detail
      ? `${options.message}\n\n${options.detail}`
      : options.message,
    {
      title: options.title,
      okLabel: options.confirmLabel || i18n.t("common:native.ok"),
      cancelLabel: i18n.t("common:native.cancel"),
      kind: options.destructive ? "warning" : "info",
    },
  );
}

// Only macOS's native popup menus are today's; Windows' and GTK's are the
// classic ones, so there the page draws the menu, where the click was
const PAGE_MENUS = !navigator.platform.includes("Mac");
let lastContextClick = { x: 0, y: 0 };
// (No window where tests import this, in Node)
if (PAGE_MENUS && typeof window !== "undefined") {
  window.addEventListener("contextmenu", (e) => (lastContextClick = { x: e.clientX, y: e.clientY }), true);
}

export async function showContextMenu(
  items: Array<{
    id: string;
    label: string;
    type?: "separator" | "normal";
    enabled?: boolean;
  }>,
): Promise<string | null> {
  if (PAGE_MENUS) {
    setNativeMenuOpen(true);
    try {
      return await showPageContextMenu(items, lastContextClick.x, lastContextClick.y);
    } finally {
      setNativeMenuOpen(false);
    }
  }
  const { Menu, MenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");

  return new Promise(async (resolve) => {
    let resolved = false;
    const menuItems = [];

    for (const item of items) {
      if (item.type === "separator") {
        menuItems.push(await PredefinedMenuItem.new({ item: "Separator" }));
      } else {
        const id = item.id;
        menuItems.push(
          await MenuItem.new({
            id: item.id,
            text: item.label,
            enabled: item.enabled !== false,
            action: () => {
              if (!resolved) {
                resolved = true;
                resolve(id);
              }
            },
          }),
        );
      }
    }

    const menu = await Menu.new({ items: menuItems });
    // Tooltips stay shut until the menu closes (popup returns then)
    setNativeMenuOpen(true);
    try {
      await menu.popup();
    } finally {
      setNativeMenuOpen(false);
    }

    // If menu dismissed without selection, resolve null after short delay
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, 100);
  });
}

/** An item of a menu opened under a control (popupMenuBelow) */
export interface PopupItem {
  /** A line between groups, or a dimmed heading */
  type?: "separator" | "label";
  label?: string;
  enabled?: boolean;
  /** Ticked: a Select's current value */
  checked?: boolean;
  run?: () => void;
}

/**
 * The system's own menu (NSMenu on macOS) under a control, in place of one
 * the page draws: the app's Select and DropdownMenu open this on macOS.
 * Resolves once it has closed.
 */
export async function popupMenuBelow(items: PopupItem[], control: Element): Promise<void> {
  const { Menu, MenuItem, CheckMenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const { LogicalPosition } = await import("@tauri-apps/api/dpi");
  const menuItems = await Promise.all(
    items.map((item) => {
      if (item.type === "separator") return PredefinedMenuItem.new({ item: "Separator" });
      // A long one (a conversation's title) cut, as the page's menus do
      const label = item.label ?? "";
      const text = label.length > 60 ? `${label.slice(0, 59)}…` : label;
      const enabled = item.type !== "label" && item.enabled !== false;
      const action = () => item.run?.();
      return item.checked === undefined
        ? MenuItem.new({ text, enabled, action })
        : CheckMenuItem.new({ text, enabled, checked: item.checked, action });
    }),
  );
  const menu = await Menu.new({ items: menuItems });
  const rect = control.getBoundingClientRect();
  setNativeMenuOpen(true);
  try {
    await menu.popup(new LogicalPosition(rect.left, rect.bottom + 4));
  } finally {
    setNativeMenuOpen(false);
  }
}

// --- System ---

export async function getAccentColor(): Promise<string> {
  return invoke("get_accent_color");
}

export async function getVersion(): Promise<string> {
  return tauriGetVersion();
}

export async function getMacosVersion(): Promise<number> {
  return invoke("macos_version");
}

export async function getStoolapVersion(): Promise<string> {
  return invoke("get_stoolap_version");
}

export async function closeExample(): Promise<void> {
  await invoke("db_close_example");
}

export async function listConnections(): Promise<
  Array<{ id: string; name: string; path: string; type: "memory" | "file" }>
> {
  return invoke("db_list");
}

// --- Native notification ---

let notificationPermission: boolean | null = null;

export async function initNotifications(): Promise<void> {
  try {
    const { isPermissionGranted, requestPermission } =
      await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    notificationPermission = granted;
  } catch {
    notificationPermission = false;
  }
}

export async function notify(title: string, body?: string) {
  if (notificationPermission === false) return;
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
  } catch {
    // Silently ignore
  }
}

// --- Menu event listeners ---

/**
 * Subscribe to a Tauri event. `listen` registers asynchronously, so the
 * returned cleanup may run before registration finishes (React StrictMode
 * does exactly that); the listener is then removed as soon as it arrives
 * instead of leaking and firing twice.
 */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  listen<T>(event, (e) => handler(e.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function onEvent(event: string, callback: () => void): () => void {
  return subscribe(event, () => callback());
}

export function onMenuOpenDatabase(callback: () => void): () => void {
  return onEvent("menu:open-database", callback);
}

export function onMenuNewMemoryDb(callback: () => void): () => void {
  return onEvent("menu:new-memory-db", callback);
}

export function onMenuLoadExample(callback: () => void): () => void {
  return onEvent("menu:load-example", callback);
}

export function onMenuBackup(callback: () => void): () => void {
  return onEvent("menu:backup", callback);
}

export function onMenuRestore(callback: () => void): () => void {
  return onEvent("menu:restore", callback);
}

export function onMenuToggleSidebar(callback: () => void): () => void {
  return onEvent("menu:toggle-sidebar", callback);
}

export function onMenuToggleAgent(callback: () => void): () => void {
  return onEvent("menu:toggle-agent", callback);
}

export function onMenuCheckUpdates(callback: () => void): () => void {
  return onEvent("menu:check-updates", callback);
}

// --- Updater ---

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

export type UpdateProgress =
  | { kind: "started"; contentLength?: number }
  | { kind: "progress"; downloaded: number; contentLength?: number }
  | { kind: "finished" };

/**
 * Check for updates. Returns the update info if an update is available, null
 * if on the latest version, and throws on network / signature errors.
 */
export async function checkForUpdate(): Promise<
  | { available: true; info: UpdateInfo; apply: (onProgress?: (p: UpdateProgress) => void) => Promise<void> }
  | { available: false }
> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return { available: false };
  return {
    available: true,
    info: {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      body: update.body,
    },
    apply: async (onProgress) => {
      let downloaded = 0;
      let contentLength: number | undefined;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength;
          onProgress?.({ kind: "started", contentLength });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          onProgress?.({ kind: "progress", downloaded, contentLength });
        } else if (event.event === "Finished") {
          onProgress?.({ kind: "finished" });
        }
      });
    },
  };
}

/** Relaunch the app (typically called after downloadAndInstall). */
export async function relaunchApp(): Promise<void> {
  await invoke("relaunch");
}

// --- Opening databases and SQL files from outside the window ---

/** Fill File → Open Recent with these databases. */
export async function setRecentDatabases(
  entries: Array<{ name: string; path: string }>,
): Promise<void> {
  await invoke("set_recent_databases", { entries });
}

/**
 * A path to open: picked from File → Open Recent, or passed to a second
 * launch of the app.
 */
export function onOpenPath(callback: (path: string) => void): () => void {
  return subscribe<string>("app:open-path", callback);
}

/** Files or folders dropped onto the window; `over` tracks the hover state. */
export function onDragDrop(handlers: {
  over: (active: boolean) => void;
  drop: (paths: string[]) => void;
}): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") handlers.over(true);
        else if (p.type === "leave") handlers.over(false);
        else if (p.type === "drop") {
          handlers.over(false);
          handlers.drop(p.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      }),
  );
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function onAccentColorChanged(
  callback: (color: string) => void,
): () => void {
  return subscribe<string>("app:accent-color-changed", callback);
}
