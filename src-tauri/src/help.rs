//! Help: a search of stoolap.io, for the Help menu (macOS's own search
//! field, macos_help.rs; the page's menu bar elsewhere). It searches the
//! site's own index (search.json: its docs and blog, as the site's search
//! box does), fetched once at launch; until then, or offline, the docs the
//! app carries for the agent. A result opens its page on stoolap.io.

use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::agent::docs_index::PAGES;

const SITE: &str = "https://stoolap.io";

/// Help → Stoolap Help
pub const DOCS_URL: &str = "https://stoolap.io/docs/";

/// Stoolap's release notes, Help → What's New in Stoolap?
pub const CHANGELOG_URL: &str = "https://github.com/stoolap/stoolap/releases";

#[derive(Serialize, Clone)]
pub struct Hit {
    pub title: String,
    pub url: String,
}

/// A page to search: its title and address, and both in lower case
struct Page {
    title: String,
    url: String,
    title_lower: String,
    text_lower: String,
}

impl Page {
    fn new(title: &str, url: String, text: &str) -> Self {
        Self {
            title: title.to_string(),
            url,
            title_lower: title.to_lowercase(),
            text_lower: text.to_lowercase(),
        }
    }
}

/// stoolap.io's index, once fetched
static SITE_INDEX: RwLock<Option<Arc<Vec<Page>>>> = RwLock::new(None);

/// The docs the app carries, at their addresses on stoolap.io
fn carried() -> Arc<Vec<Page>> {
    static CARRIED: OnceLock<Arc<Vec<Page>>> = OnceLock::new();
    CARRIED
        .get_or_init(|| {
            Arc::new(
                PAGES
                    .iter()
                    .map(|(id, title, text)| Page::new(title, format!("{DOCS_URL}{id}/"), text))
                    .collect(),
            )
        })
        .clone()
}

/// Fetches stoolap.io's search index (at launch); a failure leaves the
/// carried docs in use
pub async fn load() {
    #[derive(Deserialize)]
    struct Entry {
        title: String,
        url: String,
        #[serde(default)]
        content: String,
    }
    let Ok(response) = crate::agent::api::client()
        .get(format!("{SITE}/search.json"))
        .send()
        .await
    else {
        return;
    };
    let Ok(entries) = response.json::<Vec<Entry>>().await else {
        return;
    };
    let pages = entries
        .iter()
        .map(|e| Page::new(&e.title, format!("{SITE}{}", e.url), &e.content))
        .collect();
    if let Ok(mut index) = SITE_INDEX.write() {
        *index = Some(Arc::new(pages));
    }
}

/// The pages with every word of the query, best first, as stoolap.io's own
/// search ranks them: a word in the title counts most (more at a word's
/// start), one in the text less, the whole title matched most of all
pub fn search(query: &str, limit: usize) -> Vec<Hit> {
    let query = query.trim().to_lowercase();
    let words: Vec<&str> = query.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let pages = SITE_INDEX
        .read()
        .ok()
        .and_then(|index| index.clone())
        .unwrap_or_else(carried);
    let mut scored: Vec<(&Page, usize)> = pages
        .iter()
        .filter_map(|page| {
            let mut score = 0;
            for word in &words {
                let in_title = page.title_lower.contains(word);
                let in_text = page.text_lower.contains(word);
                if !in_title && !in_text {
                    return None;
                }
                if in_title {
                    score += 10;
                    if page.title_lower.starts_with(word)
                        || page.title_lower.contains(&format!(" {word}"))
                    {
                        score += 5;
                    }
                }
                if in_text {
                    score += 3;
                }
            }
            if page.title_lower == query {
                score += 100;
            }
            Some((page, score))
        })
        .collect();
    // Stable: equal scores keep the index's own order (docs before posts)
    scored.sort_by_key(|&(_, score)| std::cmp::Reverse(score));
    scored
        .into_iter()
        .take(limit)
        .map(|(page, _)| Hit {
            title: page.title.clone(),
            url: page.url.clone(),
        })
        .collect()
}

/// The Help menu's search, for the page's menu bar (Windows, Linux)
#[tauri::command]
pub fn docs_search(query: String) -> Vec<Hit> {
    search(&query, 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_by_title_first_and_points_at_the_site() {
        let hits = search("vector search", 8);
        assert_eq!(hits[0].title, "Vector Search");
        assert_eq!(
            hits[0].url,
            "https://stoolap.io/docs/data-types/vector-search/"
        );
    }

    #[test]
    fn needs_every_word_and_ignores_case() {
        assert!(search("JOIN", 8)
            .iter()
            .any(|h| h.title == "JOIN Operations"));
        assert!(search("join zzzznotaword", 8).is_empty());
        assert!(search("   ", 8).is_empty());
    }
}
