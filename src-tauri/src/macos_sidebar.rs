//! The sidebar's backdrop on macOS 26 and later, drawn by AppKit itself.
//!
//! Finder's and Mail's sidebars are an NSSplitViewController's sidebar item:
//! AppKit draws its Liquid Glass, tinted from the desktop picture, and keeps
//! up with each macOS's version of it. No material set behind a window
//! (NSVisualEffectView, what Tauri's effects use) gives that look. So a real
//! split view controller, with empty views, sits behind the web view; the
//! page's sidebar is clear over its sidebar item and tells it its width
//! (`macos_sidebar`).

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAnimatablePropertyContainer, NSAnimationContext, NSAppKitVersionNumber,
    NSAutoresizingMaskOptions, NSColor, NSSplitViewController, NSSplitViewItem, NSToolbar, NSView,
    NSViewController, NSWindow, NSWindowOrderingMode, NSWindowToolbarStyle,
};
use objc2_foundation::ns_string;

/// AppKit's version in macOS 26, the first with Liquid Glass
const APPKIT_26: f64 = 2685.0;

struct Sidebar {
    controller: Retained<NSSplitViewController>,
    item: Retained<NSSplitViewItem>,
}

thread_local! {
    // AppKit objects stay on the main thread, where setup and the command run
    static SIDEBAR: RefCell<Option<Sidebar>> = const { RefCell::new(None) };
}

/// Puts the split view behind the window's web view. False before macOS 26,
/// or when the window's views can't be had; the caller keeps the old material.
pub fn install(window: &tauri::WebviewWindow) -> bool {
    // SAFETY: a plain read of AppKit's version constant
    if unsafe { NSAppKitVersionNumber } < APPKIT_26 {
        return false;
    }
    let (Some(mtm), Ok(ns_window)) = (MainThreadMarker::new(), window.ns_window()) else {
        return false;
    };
    // SAFETY: Tauri hands out its live NSWindow, used here on the main thread
    let ns_window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
    let Some(content) = ns_window.contentView() else {
        return false;
    };

    let empty = || {
        let controller = NSViewController::new(mtm);
        controller.setView(&NSView::new(mtm));
        controller
    };
    let item = NSSplitViewItem::sidebarWithViewController(&empty());
    item.setAllowsFullHeightLayout(true);
    item.setCanCollapse(true);
    let controller = NSSplitViewController::new(mtm);
    controller.addSplitViewItem(&item);
    controller.addSplitViewItem(&NSSplitViewItem::splitViewItemWithViewController(&empty()));

    let view = controller.view();
    view.setFrame(content.bounds());
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
    // The window's own background, which macOS tints from the desktop picture
    ns_window.setBackgroundColor(Some(&NSColor::windowBackgroundColor()));
    // An empty toolbar: macOS then sets the traffic lights as in its own
    // apps' windows (larger, centred in a taller title bar), where the
    // page's sidebar header has them
    let toolbar = NSToolbar::initWithIdentifier(NSToolbar::alloc(mtm), ns_string!("main"));
    ns_window.setToolbar(Some(&toolbar));
    ns_window.setToolbarStyle(NSWindowToolbarStyle::Unified);

    SIDEBAR.with(|s| *s.borrow_mut() = Some(Sidebar { controller, item }));
    true
}

/// The page's sidebar: its width in points, and whether it is open
pub fn set(width: f64, open: bool) {
    SIDEBAR.with(|s| {
        if let Some(Sidebar { controller, item }) = s.borrow().as_ref() {
            if item.isCollapsed() == open {
                // Opening or closing: over the 200ms the page's sidebar
                // slides in (app-shell.tsx)
                NSAnimationContext::beginGrouping();
                NSAnimationContext::currentContext().setDuration(0.2);
                item.animator().setCollapsed(!open);
                NSAnimationContext::endGrouping();
            }
            if open {
                controller
                    .splitView()
                    .setPosition_ofDividerAtIndex(width, 0);
            }
        }
    });
}
