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
import { getVersion as tauriGetVersion } from "@tauri-apps/api/app";

// --- Dialogs ---

export async function showOpenDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: true,
    title: "Open Stoolap Database",
  });
  return typeof selected === "string" ? selected : null;
}

export async function showSaveDialog(
  defaultName: string,
): Promise<string | null> {
  const result = await save({
    defaultPath: defaultName,
    filters: [
      { name: "SQL Files", extensions: ["sql"] },
      { name: "All Files", extensions: ["*"] },
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
  return confirm(
    options.detail
      ? `${options.message}\n\n${options.detail}`
      : options.message,
    {
      title: options.title,
      okLabel: options.confirmLabel || "OK",
      cancelLabel: "Cancel",
      kind: options.destructive ? "warning" : "info",
    },
  );
}

export async function showContextMenu(
  items: Array<{
    id: string;
    label: string;
    type?: "separator" | "normal";
    enabled?: boolean;
  }>,
): Promise<string | null> {
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
    await menu.popup();

    // If menu dismissed without selection, resolve null after short delay
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, 100);
  });
}

// --- System ---

export async function getAccentColor(): Promise<string> {
  return invoke("get_accent_color");
}

export async function getVersion(): Promise<string> {
  return tauriGetVersion();
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

function onEvent(event: string, callback: () => void): () => void {
  let unlisten: UnlistenFn | null = null;
  listen(event, () => callback()).then((fn) => {
    unlisten = fn;
  });
  return () => {
    unlisten?.();
  };
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

export function onMenuAbout(callback: () => void): () => void {
  return onEvent("menu:about", callback);
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
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export function onAccentColorChanged(
  callback: (color: string) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  listen<string>("app:accent-color-changed", (event) =>
    callback(event.payload),
  ).then((fn) => {
    unlisten = fn;
  });
  return () => {
    unlisten?.();
  };
}
