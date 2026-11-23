//! macOS's own Help search: what is typed in the Help menu's search field
//! also lists Stoolap's documentation, under Help Topics, next to the menu
//! commands it finds; choosing one opens its page (help.rs).

use std::ptr::NonNull;

use block2::DynBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSUserInterfaceItemSearching};
use objc2_foundation::{NSArray, NSInteger, NSString};

use crate::help;

/// An item is its page's title and address, a line apart
fn item(hit: &help::Hit) -> Retained<NSString> {
    NSString::from_str(&format!("{}\n{}", hit.title, hit.url))
}

fn parts(item: &AnyObject) -> Option<(String, String)> {
    let text = item.downcast_ref::<NSString>()?.to_string();
    let (title, url) = text.split_once('\n')?;
    Some((title.to_string(), url.to_string()))
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; AppKit calls it on
    // the main thread or its search queue, and it holds no state
    #[unsafe(super(NSObject))]
    #[name = "StoolapHelpSearch"]
    struct HelpSearch;

    unsafe impl NSObjectProtocol for HelpSearch {}

    unsafe impl NSUserInterfaceItemSearching for HelpSearch {
        #[unsafe(method(searchForItemsWithSearchString:resultLimit:matchedItemHandler:))]
        fn search(
            &self,
            query: &NSString,
            limit: NSInteger,
            handler: &DynBlock<dyn Fn(NonNull<NSArray>)>,
        ) {
            let items: Vec<_> = help::search(&query.to_string(), limit.max(0) as usize)
                .iter()
                .map(item)
                .collect();
            let items = NSArray::from_retained_slice(&items);
            handler.call((NonNull::from(&*items).cast(),));
        }

        #[unsafe(method_id(localizedTitlesForItem:))]
        fn titles(&self, item: &AnyObject) -> Retained<NSArray<NSString>> {
            let title = parts(item).map(|(title, _)| title).unwrap_or_default();
            NSArray::from_retained_slice(&[NSString::from_str(&title)])
        }

        #[unsafe(method(performActionForItem:))]
        fn open(&self, item: &AnyObject) {
            if let Some((_, url)) = parts(item) {
                let _ = crate::agent::agent_open_link(url);
            }
        }

        #[unsafe(method(showAllHelpTopicsForSearchString:))]
        fn show_all(&self, _query: &NSString) {
            let _ = crate::agent::agent_open_link(help::DOCS_URL.into());
        }
    }
);

/// Adds the documentation to the Help menu's search, for the app's life
pub fn register() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    // SAFETY: NSObject's init on a freshly allocated object
    let handler: Retained<HelpSearch> = unsafe { msg_send![HelpSearch::alloc(), init] };
    NSApplication::sharedApplication(mtm)
        .registerUserInterfaceItemSearchHandler(ProtocolObject::from_ref(&*handler));
    // AppKit doesn't keep it: it stays for as long as the app runs
    std::mem::forget(handler);
}
