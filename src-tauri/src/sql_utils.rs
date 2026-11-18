/// Strip SQL comments (line and block) while preserving string literals.
pub fn strip_comments(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut result: Vec<u8> = Vec::with_capacity(sql.len());
    let mut i = 0;
    let len = bytes.len();

    while i < len {
        // Single-quoted string
        if bytes[i] == b'\'' {
            result.push(b'\'');
            i += 1;
            while i < len {
                if bytes[i] == b'\'' && i + 1 < len && bytes[i + 1] == b'\'' {
                    result.extend_from_slice(b"''");
                    i += 2;
                } else if bytes[i] == b'\'' {
                    result.push(b'\'');
                    i += 1;
                    break;
                } else {
                    result.push(bytes[i]);
                    i += 1;
                }
            }
            continue;
        }
        // Double-quoted identifier
        if bytes[i] == b'"' {
            result.push(b'"');
            i += 1;
            while i < len {
                if bytes[i] == b'"' && i + 1 < len && bytes[i + 1] == b'"' {
                    result.extend_from_slice(b"\"\"");
                    i += 2;
                } else if bytes[i] == b'"' {
                    result.push(b'"');
                    i += 1;
                    break;
                } else {
                    result.push(bytes[i]);
                    i += 1;
                }
            }
            continue;
        }
        // Line comment
        if bytes[i] == b'-' && i + 1 < len && bytes[i + 1] == b'-' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Block comment
        if bytes[i] == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < len {
                i += 2;
            }
            continue;
        }
        result.push(bytes[i]);
        i += 1;
    }
    // Only whole comments are removed, cut at ASCII bytes, so the bytes
    // left are valid UTF-8.
    String::from_utf8_lossy(&result).trim().to_string()
}

/// Split SQL into individual statements (semicolon-separated), respecting string literals.
pub fn split_statements(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut current: Vec<u8> = Vec::new();
    let mut i = 0;
    let len = bytes.len();

    while i < len {
        if bytes[i] == b'\'' {
            current.push(b'\'');
            i += 1;
            while i < len {
                if bytes[i] == b'\'' && i + 1 < len && bytes[i + 1] == b'\'' {
                    current.extend_from_slice(b"''");
                    i += 2;
                } else if bytes[i] == b'\'' {
                    current.push(b'\'');
                    i += 1;
                    break;
                } else {
                    current.push(bytes[i]);
                    i += 1;
                }
            }
            continue;
        }
        if bytes[i] == b'"' {
            current.push(b'"');
            i += 1;
            while i < len {
                if bytes[i] == b'"' && i + 1 < len && bytes[i + 1] == b'"' {
                    current.extend_from_slice(b"\"\"");
                    i += 2;
                } else if bytes[i] == b'"' {
                    current.push(b'"');
                    i += 1;
                    break;
                } else {
                    current.push(bytes[i]);
                    i += 1;
                }
            }
            continue;
        }
        if bytes[i] == b';' {
            push_statement(&mut statements, &current);
            current.clear();
            i += 1;
            continue;
        }
        current.push(bytes[i]);
        i += 1;
    }
    push_statement(&mut statements, &current);
    statements
}

/// Statements are cut at `;` (ASCII), so each one is valid UTF-8.
fn push_statement(statements: &mut Vec<String>, bytes: &[u8]) {
    let stmt = String::from_utf8_lossy(bytes).trim().to_string();
    if !stmt.is_empty() {
        statements.push(stmt);
    }
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
        return classify_with_body(sql.trim_start());
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

/// True if `RETURNING` appears as a word outside string literals and quoted
/// identifiers.
pub fn has_returning(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        let c = bytes[i];
        if c == b'\'' || c == b'"' {
            i += 1;
            while i < len {
                if bytes[i] == c {
                    if i + 1 < len && bytes[i + 1] == c {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            let start = i;
            while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            if sql[start..i].eq_ignore_ascii_case("RETURNING") {
                return true;
            }
            continue;
        }
        i += 1;
    }
    false
}

fn classify_with_body(sql: &str) -> StatementType {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut depth: i32 = 0;
    let len = bytes.len();
    while i < len {
        let c = bytes[i];
        if c == b'\'' || c == b'"' {
            let quote = c;
            i += 1;
            while i < len {
                if bytes[i] == quote {
                    if i + 1 < len && bytes[i + 1] == quote {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == b'(' {
            depth += 1;
            i += 1;
            continue;
        }
        if c == b')' {
            depth -= 1;
            i += 1;
            continue;
        }
        if depth == 0 && (c.is_ascii_alphabetic() || c == b'_') {
            let start = i;
            while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let word = sql[start..i].to_ascii_uppercase();
            match word.as_str() {
                "SELECT" => return StatementType::Query,
                "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "UPSERT" | "REPLACE" => {
                    return StatementType::Dml;
                }
                _ => continue,
            }
        }
        i += 1;
    }
    // Couldn't identify: treat as Query (safer: read-only assumption won't run
    // DML under a forgotten transaction wrapper).
    StatementType::Query
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
