use stoolap::parser::lexer::Lexer;
use stoolap::parser::token::{Token, TokenType};

/// The engine's own tokens for `sql`, up to the first one it can't read
/// (an unterminated string, say): what follows is left for the engine to
/// reject. Reading SQL with the engine's lexer, not a copy of its rules,
/// keeps quotes (a backslash escapes inside '...'), `identifiers` and
/// # comments read the way the engine reads them.
fn tokens(sql: &str) -> Vec<Token> {
    let mut lexer = Lexer::new(sql);
    let mut out = Vec::new();
    loop {
        let t = lexer.next_token();
        if matches!(t.token_type, TokenType::Eof | TokenType::Error) {
            return out;
        }
        out.push(t);
    }
}

/// A comment token's byte range; None for an unterminated block comment,
/// which is left in place so the engine reports it.
fn comment_range(t: &Token) -> Option<std::ops::Range<usize>> {
    let text: &str = &t.literal;
    if text.starts_with("/*") && (text.len() < 4 || !text.ends_with("*/")) {
        return None;
    }
    let start = t.position.offset as usize;
    Some(start..start + text.len())
}

/// Strip SQL comments; each becomes a space, so `SELECT/*x*/1` stays two words.
pub fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut at = 0;
    for t in tokens(sql) {
        if t.token_type != TokenType::Comment {
            continue;
        }
        if let Some(range) = comment_range(&t) {
            out.push_str(&sql[at..range.start]);
            out.push(' ');
            at = range.end;
        }
    }
    out.push_str(&sql[at..]);
    out.trim().to_string()
}

/// Split SQL into statements at the semicolons the engine sees.
pub fn split_statements(sql: &str) -> Vec<String> {
    split_statements_at(sql).into_iter().map(|s| s.sql).collect()
}

/// A statement and where it starts in the text it was split from
#[derive(Debug, Clone, PartialEq)]
pub struct Located {
    pub sql: String,
    /// 1-based
    pub line: usize,
    /// 1-based, in characters
    pub column: usize,
}

/// Split SQL into statements, each with the line and column it starts at,
/// so an error in one can point into the whole text (a restored dump).
pub fn split_statements_at(sql: &str) -> Vec<Located> {
    let mut statements = Vec::new();
    // Where the counting got to: a byte offset and its line, read once
    let mut counted = (0, 1);
    let mut push = |text_start: usize, text_end: usize| {
        let text = &sql[text_start..text_end];
        let stmt = text.trim();
        if stmt.is_empty() {
            return;
        }
        let start = text_start + (text.len() - text.trim_start().len());
        counted.1 += sql[counted.0..start].matches('\n').count();
        counted.0 = start;
        let line_start = sql[..start].rfind('\n').map_or(0, |i| i + 1);
        let column = sql[line_start..start].chars().count() + 1;
        statements.push(Located { sql: stmt.to_string(), line: counted.1, column });
    };
    let mut at = 0;
    for t in tokens(sql) {
        if t.token_type == TokenType::Punctuator && &*t.literal == ";" {
            let end = t.position.offset as usize;
            push(at, end);
            at = end + 1;
        }
    }
    push(at, sql.len());
    statements
}

/// An unquoted word token (keyword or plain identifier) spelling `word`
fn is_word(t: &Token, word: &str) -> bool {
    matches!(t.token_type, TokenType::Keyword | TokenType::Identifier) && !t.quoted && t.literal.eq_ignore_ascii_case(word)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StatementType {
    Query,
    Ddl,
    Dml,
}

pub fn classify_statement(sql: &str) -> StatementType {
    let upper = sql.trim_start().to_uppercase();
    if upper.starts_with("SELECT")
        || upper.starts_with("SHOW")
        || upper.starts_with("DESCRIBE")
        || upper.starts_with("DESC ")
        || upper.starts_with("EXPLAIN")
        || upper.starts_with("PRAGMA")
    {
        return StatementType::Query;
    }
    if upper.starts_with("WITH") {
        // Look past the CTE chain for the actual body keyword. CTEs can chain
        // (`WITH a AS (...), b AS (...) SELECT ...`), so scan for the first
        // top-level SELECT/INSERT/UPDATE/DELETE after depth returns to zero.
        // As below, DML with RETURNING returns its rows as a query
        return match classify_with_body(sql.trim_start()) {
            StatementType::Dml if has_returning(sql) => StatementType::Query,
            t => t,
        };
    }
    if upper.starts_with("CREATE")
        || upper.starts_with("DROP")
        || upper.starts_with("ALTER")
        || upper.starts_with("TRUNCATE")
        || upper.starts_with("BEGIN")
        || upper.starts_with("COMMIT")
        || upper.starts_with("ROLLBACK")
        || upper.starts_with("SAVEPOINT")
    {
        return StatementType::Ddl;
    }
    // DML with RETURNING produces rows, which only a query returns (execute
    // reports 0 changes and drops them).
    if has_returning(sql) {
        return StatementType::Query;
    }
    StatementType::Dml
}

/// True when the statement changes rows, whatever it returns: an INSERT
/// with RETURNING runs as a query but still needs a script's transaction.
pub fn modifies_data(sql: &str) -> bool {
    let upper = sql.trim_start().to_uppercase();
    if upper.starts_with("WITH") {
        return classify_with_body(sql.trim_start()) == StatementType::Dml;
    }
    ["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE"]
        .iter()
        .any(|k| upper.starts_with(k))
}

/// True if `RETURNING` appears as a word, not in a string or quoted name.
pub fn has_returning(sql: &str) -> bool {
    tokens(sql).iter().any(|t| is_word(t, "RETURNING"))
}

/// A WITH statement's kind: the first top-level SELECT/INSERT/... after
/// its CTEs.
fn classify_with_body(sql: &str) -> StatementType {
    let mut depth = 0i32;
    for t in tokens(sql) {
        if t.token_type == TokenType::Punctuator {
            match &*t.literal {
                "(" => depth += 1,
                ")" => depth -= 1,
                _ => {}
            }
            continue;
        }
        if depth != 0 {
            continue;
        }
        if is_word(&t, "SELECT") {
            return StatementType::Query;
        }
        if ["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE"].iter().any(|w| is_word(&t, w)) {
            return StatementType::Dml;
        }
    }
    // Couldn't identify: treat as Query (safer: read-only assumption won't run
    // DML under a forgotten transaction wrapper).
    StatementType::Query
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statements_know_where_they_start() {
        let sql = "-- dump\nCREATE TABLE t (a INTEGER);\n\nINSERT INTO t VALUES (1);  INSERT INTO t\nVALUES (2);";
        let at: Vec<(usize, usize)> = split_statements_at(sql).iter().map(|s| (s.line, s.column)).collect();
        // The comment belongs to the first statement, which starts at it
        assert_eq!(at, [(1, 1), (4, 1), (4, 28)]);
    }

    #[test]
    fn keeps_non_ascii_text() {
        let sql = "INSERT INTO t VALUES ('çay şeker', \"ığü\") -- yorum ö\n/* ü */";
        assert_eq!(
            strip_comments(sql),
            "INSERT INTO t VALUES ('çay şeker', \"ığü\")"
        );
        assert_eq!(
            split_statements("SELECT 'ç;ş'; SELECT 'ö'"),
            vec!["SELECT 'ç;ş'", "SELECT 'ö'"]
        );
    }

    #[test]
    fn returning_is_a_query() {
        assert_eq!(
            classify_statement("INSERT INTO t VALUES (1) RETURNING id"),
            StatementType::Query
        );
        assert_eq!(
            classify_statement("UPDATE t SET v = 'RETURNING' WHERE id = 1"),
            StatementType::Dml
        );
        assert_eq!(
            classify_statement("DELETE FROM \"returning\" WHERE id = 1"),
            StatementType::Dml
        );
    }

    /// Shared with the renderer's splitter tests (sql-split-cases.json):
    /// each case is checked against the engine's parser here, so the
    /// expected splits are the engine's
    #[test]
    fn splits_where_the_engine_does() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../src/renderer/src/lib/sql-split-cases.json")).unwrap();
        for case in cases {
            let sql = case["sql"].as_str().unwrap();
            let expected: Vec<&str> = case["statements"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            let engine = stoolap::parser::parse_sql(sql).unwrap_or_else(|e| panic!("{sql}: {e}"));
            assert_eq!(engine.len(), expected.len(), "engine: {sql}");
            assert_eq!(split_statements(sql), expected, "{}", case["why"]);
        }
    }

    #[test]
    fn a_stripped_comment_leaves_a_space_and_an_unterminated_one_stays() {
        assert_eq!(strip_comments("SELECT/*x*/1"), "SELECT 1");
        assert_eq!(strip_comments("SELECT 1 # note"), "SELECT 1");
        let unterminated = "INSERT INTO t VALUES (2) /* oops";
        assert_eq!(strip_comments(unterminated), unterminated);
    }
}
