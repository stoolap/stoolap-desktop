import { createRoot } from "react-dom/client";
import { DropdownMenu } from "radix-ui";

export interface ContextMenuItem {
  id: string;
  label: string;
  type?: "separator" | "normal";
  enabled?: boolean;
}

/**
 * A right-click menu drawn in the page, as the menu bar's (WinMenubar) are:
 * Windows' and GTK's native popup menus are the classic ones. Opens at the
 * point given and resolves the chosen item's id, or null when dismissed.
 */
export function showPageContextMenu(items: ContextMenuItem[], x: number, y: number): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const previousFocus = document.activeElement as HTMLElement | null;
    let chosen: string | null = null;

    const close = () => {
      root.unmount();
      host.remove();
      previousFocus?.focus();
      resolve(chosen);
    };

    root.render(
      <DropdownMenu.Root open onOpenChange={(open) => !open && setTimeout(close, 0)}>
        <DropdownMenu.Trigger asChild>
          <span style={{ position: "fixed", left: x, top: y, width: 0, height: 0 }} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          className="win-menu win-flyout"
          side="bottom"
          align="start"
          collisionPadding={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {items.map((item, i) =>
            item.type === "separator" ? (
              <DropdownMenu.Separator key={i} className="win-flyout-separator" />
            ) : (
              <DropdownMenu.Item
                key={item.id}
                className="win-flyout-item"
                disabled={item.enabled === false}
                onSelect={() => (chosen = item.id)}
              >
                <span className="flex-1 truncate">{item.label}</span>
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>,
    );
  });
}
