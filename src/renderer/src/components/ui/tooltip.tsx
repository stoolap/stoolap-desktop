
import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

/** A native menu (native.showContextMenu) is open: tooltips close and don't
 *  open until it has. The page still sees the pointer move under the menu,
 *  and never sees it leave what it was over. */
let menuOpen = false;
const CLOSE_TOOLTIPS = "stoolap:close-tooltips";
export function setNativeMenuOpen(open: boolean) {
  menuOpen = open;
  if (open) window.dispatchEvent(new Event(CLOSE_TOOLTIPS));
}

function Tooltip({
  open: openProp,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [open, setOpen] = React.useState(false);
  const controlled = openProp !== undefined;
  React.useEffect(() => {
    const close = () => (controlled ? onOpenChange?.(false) : setOpen(false));
    window.addEventListener(CLOSE_TOOLTIPS, close);
    return () => window.removeEventListener(CLOSE_TOOLTIPS, close);
  }, [controlled, onOpenChange]);
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      open={controlled ? openProp : open}
      onOpenChange={(next) => {
        if (next && menuOpen) return;
        if (!controlled) setOpen(next);
        onOpenChange?.(next);
      }}
      {...props}
    />
  );
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Content
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        "z-[9999] w-fit rounded-md px-2 py-1 text-xs",
        className,
      )}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
