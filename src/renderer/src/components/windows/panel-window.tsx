import { useEffect, useRef } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AboutWindow } from "./about-window";
import { SettingsWindow } from "./settings-window";

/**
 * The page of the Settings and About windows. Rust opens them hidden; the
 * window takes its content's height (which follows the language) and shows.
 */
export function PanelWindow({ label }: { label: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const win = getCurrentWindow();
    let shown = false;
    // The size set can include the title bar: measure what the page gets
    // and grow the window by what's missing
    let extra = 0;
    const fit = async () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      await win.setSize(new LogicalSize(window.innerWidth, height + extra));
      // The page hears of the new size a moment later (if it changed at all)
      await new Promise<void>((resolve) => {
        const done = () => {
          window.removeEventListener("resize", done);
          resolve();
        };
        window.addEventListener("resize", done);
        setTimeout(done, 150);
      });
      const missing = height - window.innerHeight;
      if (missing > 0) {
        extra += missing;
        await win.setSize(new LogicalSize(window.innerWidth, height + extra));
      }
      if (!shown) {
        shown = true;
        await win.show();
        await win.setFocus();
      }
    };
    const observer = new ResizeObserver(() => fit().catch(() => {}));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div ref={ref}>{label === "about" ? <AboutWindow /> : <SettingsWindow />}</div>
      <Toaster position="bottom-center" />
    </TooltipProvider>
  );
}
