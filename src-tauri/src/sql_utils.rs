/// Strip SQL comments (line and block) while preserving string literals.
pub fn strip_comments(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut result = String::with_capacity(sql.len());
    let mut i = 0;
    let len = bytes.len();

    while i < len {
        // Single-quoted string
        if bytes[i] == b'\'' {
            result.push('\'');
            i += 1;
            while i < len {
                if bytes[i] == b'\'' && i + 1 < len && bytes[i + 1] == b'\'' {
                    result.push_str("''");
                    i += 2;
                } else if bytes[i] == b'\'' {
                    result.push('\'');
                    i += 1;
                    break;
                } else {
                    result.push(bytes[i] as char);
                    i += 1;
                }
            }
            continue;
        }
        // Double-quoted identifier
        if bytes[i] == b'"' {
            result.push('"');
            i += 1;
            while i < len {
                if bytes[i] == b'"' && i + 1 < len && bytes[i + 1] == b'"' {
                    result.push_str("\"\"");
                    i += 2;
                } else if bytes[i] == b'"' {
                    result.push('"');
                    i += 1;
                    break;
                } else {
                    result.push(bytes[i] as char);
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
        result.push(bytes[i] as char);
        i += 1;
    }
    result.trim().to_string()
}

/// Split SQL into individual statements (semicolon-separated), respecting string literals.
pub fn split_statements(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    let len = bytes.len();

    while i < len {
        if bytes[i] == b'\'' {
            current.push('\'');
            i += 1;
            while i < len {
                if bytes[i] == b'\'' && i + 1 < len && bytes[i + 1] == b'\'' {
                    current.push_str("''");
                    i += 2;
                } else if bytes[i] == b'\'' {
                    current.push('\'');
                    i += 1;
                    break;
                } else {
                    current.push(bytes[i] as char);
                    i += 1;
                }
            }
            continue;
        }
        if bytes[i] == b'"' {
            current.push('"');
            i += 1;
            while i < len {
                if bytes[i] == b'"' && i + 1 < len && bytes[i + 1] == b'"' {
                    current.push_str("\"\"");
                    i += 2;
                } else if bytes[i] == b'"' {
                    current.push('"');
                    i += 1;
                    break;
                } else {
                    current.push(bytes[i] as char);
                    i += 1;
                }
            }
            continue;
        }
        if bytes[i] == b';' {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                statements.push(trimmed);
            }
            current.clear();
            i += 1;
            continue;
        }
        current.push(bytes[i] as char);
        i += 1;
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        statements.push(trimmed);
    }
    statements
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
    StatementType::Dml
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
