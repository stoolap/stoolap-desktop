//! Read a string field out of a tool input that is still streaming in.

/// The decoded prefix of `"field": "..."` in `json`, which may stop anywhere
/// (mid-value, mid-escape). None until the value has started.
pub fn string_field(json: &str, field: &str) -> Option<String> {
    let key = format!("\"{field}\"");
    let mut search = 0;
    // The key could also appear inside another value; take the first one
    // followed by a colon.
    let value_start = loop {
        let at = json[search..].find(&key)? + search;
        let rest = json[at + key.len()..].trim_start();
        if let Some(after_colon) = rest.strip_prefix(':') {
            let after_colon = after_colon.trim_start();
            let quote = after_colon.strip_prefix('"')?;
            break json.len() - quote.len();
        }
        search = at + key.len();
    };

    let mut out = String::new();
    let mut chars = json[value_start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('b') => out.push('\u{8}'),
                Some('f') => out.push('\u{c}'),
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    if hex.len() < 4 {
                        return Some(out); // escape not complete yet
                    }
                    match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                        Some(ch) => out.push(ch),
                        // Half of a surrogate pair: wait for the whole character
                        None => return Some(out),
                    }
                }
                Some(other) => out.push(other), // \" \\ \/
                None => return Some(out),
            },
            c => out.push(c),
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::string_field;

    #[test]
    fn reads_a_value_as_it_streams_in() {
        assert_eq!(string_field("{\"sq", "sql"), None);
        assert_eq!(string_field("{\"sql\": ", "sql"), None);
        assert_eq!(string_field("{\"sql\": \"SEL", "sql").as_deref(), Some("SEL"));
        assert_eq!(
            string_field("{\"sql\": \"SELECT 'a\\\"b'\\nFROM t\", \"explanation\": \"x\"}", "sql").as_deref(),
            Some("SELECT 'a\"b'\nFROM t")
        );
        // Stops before an unfinished escape
        assert_eq!(string_field("{\"sql\": \"a\\", "sql").as_deref(), Some("a"));
        assert_eq!(string_field("{\"sql\": \"\\u00e7\\u00", "sql").as_deref(), Some("ç"));
    }

    #[test]
    fn finds_the_key_not_a_mention_of_it() {
        let json = "{\"explanation\": \"set \\\"sql\\\" here\", \"sql\": \"SELECT 1\"}";
        assert_eq!(string_field(json, "sql").as_deref(), Some("SELECT 1"));
    }
}
