import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Toaster } from "sonner";
import { AboutWindow } from "./about-window";

/**
 * The page of the About window (outside macOS). Rust opens it hidden; the
 * window takes its content's height (which follows the language) and shows
 * once the page has what it shows, so nothing fills in after.
 */
export function PanelWindow() {
  const ref = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => Promise<void>) | null>(null);
  const ready = useRef(false);
  const onReady = useCallback(() => {
    ready.current = true;
    fitRef.current?.().catch(() => {});
  }, []);

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
      if (!shown && ready.current) {
        shown = true;
        await win.show();
        await win.setFocus();
      }
    };
    fitRef.current = fit;
    const observer = new ResizeObserver(() => fit().catch(() => {}));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={ref}><AboutWindow onReady={onReady} /></div>
      <Toaster position="bottom-center" />
    </>
  );
}
