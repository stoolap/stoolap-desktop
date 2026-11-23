import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Menubar } from "radix-ui";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, ChevronRight } from "lucide-react";
import { useHistoryStore } from "@/stores/history-store";
import { LANGUAGES, type LanguageInfo } from "@/lib/i18n";

/**
 * The menu bar as Windows 11's own apps (Paint, Notepad) have it: in the
 * window, over Mica, its menus WinUI's MenuFlyout. Neither can be had from
 * a Win32 window (its menu bar's text can't be drawn over Mica, and its
 * popup menus are the classic ones), so the page draws them. The items do
 * what the native menu's do: menu_select runs them in the backend by the
 * same ids; Edit and Window act on the page and the window here.
 */
export function WinMenubar() {
  const { t } = useTranslation("native");
  const recent = useHistoryStore((s) => s.recentConnections).filter((e) => e.type === "file");
  const [language, setLanguage] = useState<LanguageInfo | null>(null);
  // Where the focus was before the menu took it: Edit's commands act there
  const lastFocus = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const select = (id: string) => invoke("menu_select", { id }).catch(() => {});
  const onPage = (act: () => void) => () => {
    // Once the menu has closed and the focus is back where it was
    setTimeout(() => {
      lastFocus.current?.focus();
      act();
    }, 0);
  };
  const paste = async () => {
    const text = await navigator.clipboard.readText().catch(() => null);
    if (text !== null) document.execCommand("insertText", false, text);
    else document.execCommand("paste");
  };
  const remember = () => {
    if (!root.current?.contains(document.activeElement)) {
      lastFocus.current = document.activeElement as HTMLElement | null;
    }
  };

  // Alt alone (pressed and let go) or F10 moves to the bar, as in Windows'
  useEffect(() => {
    let altAlone = false;
    const focusBar = () => {
      remember();
      root.current?.querySelector<HTMLElement>("[data-menubar-trigger]")?.focus();
    };
    const down = (e: KeyboardEvent) => {
      altAlone = e.key === "Alt" && !e.repeat;
      if (e.key === "F10" && !e.shiftKey) {
        e.preventDefault();
        focusBar();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt" && altAlone) {
        e.preventDefault();
        focusBar();
      }
      altAlone = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const systemName = LANGUAGES.find((l) => l.code === language?.system)?.name ?? "English";

  return (
    <Menubar.Root
      ref={root}
      className="win-menu flex h-10 shrink-0 items-center gap-1 px-1.5"
      onPointerDownCapture={remember}
      onValueChange={(open) => {
        // The language menu ticks the current choice: read it as a menu opens
        if (open) invoke<LanguageInfo>("get_language").then(setLanguage).catch(() => {});
      }}
    >
      <Menu label={t("file")}>
        <Item onSelect={() => select("open-db")} shortcut="Ctrl+O">{t("openDatabase")}</Item>
        <Sub label={t("openRecent")}>
          {recent.length === 0 ? (
            <Item disabled>{t("noRecent")}</Item>
          ) : (
            recent.map((e) => (
              <Item key={e.path} onSelect={() => select(`recent:${e.path}`)}>
                {e.name}
              </Item>
            ))
          )}
        </Sub>
        <Item onSelect={() => select("new-memory")} shortcut="Ctrl+N">{t("newMemory")}</Item>
        <Item onSelect={() => select("load-example")}>{t("loadExample")}</Item>
        <Separator />
        <Item onSelect={() => select("backup")} shortcut="Ctrl+Shift+S">{t("backup")}</Item>
        <Item onSelect={() => select("restore")}>{t("restore")}</Item>
        <Separator />
        <Item onSelect={() => getCurrentWindow().close()}>{t("closeWindow")}</Item>
      </Menu>
      <Menu label={t("edit")}>
        <Item onSelect={onPage(() => document.execCommand("undo"))} shortcut="Ctrl+Z">{t("undo")}</Item>
        <Item onSelect={onPage(() => document.execCommand("redo"))} shortcut="Ctrl+Y">{t("redo")}</Item>
        <Separator />
        <Item onSelect={onPage(() => document.execCommand("cut"))} shortcut="Ctrl+X">{t("cut")}</Item>
        <Item onSelect={onPage(() => document.execCommand("copy"))} shortcut="Ctrl+C">{t("copy")}</Item>
        <Item onSelect={onPage(paste)} shortcut="Ctrl+V">{t("paste")}</Item>
        <Item onSelect={onPage(() => document.execCommand("selectAll"))} shortcut="Ctrl+A">{t("selectAll")}</Item>
      </Menu>
      <Menu label={t("view")}>
        <Item onSelect={() => select("toggle-sidebar")} shortcut="Ctrl+B">{t("toggleSidebar")}</Item>
        <Item onSelect={() => select("toggle-agent")} shortcut="Ctrl+L">{t("toggleAgent")}</Item>
        <Separator />
        <Sub label={t("language")}>
          <Item checked={language?.preference === "system"} onSelect={() => select("language:system")}>
            {t("systemLanguage", { language: systemName })}
          </Item>
          <Separator />
          {LANGUAGES.map((l) => (
            <Item key={l.code} checked={language?.preference === l.code} onSelect={() => select(`language:${l.code}`)}>
              {l.name}
            </Item>
          ))}
        </Sub>
      </Menu>
      <Menu label={t("window")}>
        <Item onSelect={() => getCurrentWindow().minimize()}>{t("minimize")}</Item>
      </Menu>
      <Menu label={t("help")}>
        <Item onSelect={() => select("check-updates")}>{t("checkUpdates")}</Item>
        <Separator />
        <Item onSelect={() => select("about")}>{t("about")}</Item>
      </Menu>
    </Menubar.Root>
  );
}

function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menubar.Menu>
      <Menubar.Trigger data-menubar-trigger className="win-menu-button">
        {label}
      </Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content
          className="win-menu win-flyout"
          align="start"
          sideOffset={2}
          // The focus goes back to the page (onPage), not to the bar
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {children}
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

function Item({
  children,
  onSelect,
  shortcut,
  checked,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menubar.Item className="win-flyout-item" onSelect={onSelect} disabled={disabled}>
      <span className="win-flyout-check">{checked && <Check className="h-4 w-4" />}</span>
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="win-flyout-shortcut">{shortcut}</span>}
    </Menubar.Item>
  );
}

function Sub({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menubar.Sub>
      <Menubar.SubTrigger className="win-flyout-item">
        <span className="win-flyout-check" />
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight className="h-4 w-4 opacity-60" />
      </Menubar.SubTrigger>
      <Menubar.Portal>
        <Menubar.SubContent className="win-menu win-flyout max-h-[70vh] overflow-y-auto" sideOffset={2}>
          {children}
        </Menubar.SubContent>
      </Menubar.Portal>
    </Menubar.Sub>
  );
}

function Separator() {
  return <Menubar.Separator className="win-flyout-separator" />;
}
