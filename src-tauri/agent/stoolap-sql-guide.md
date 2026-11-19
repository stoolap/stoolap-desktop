# Stoolap 0.5 SQL guide

Stoolap is an embedded SQL database (in-process; in-memory or one database directory) with MVCC transactions, a planner that uses statistics from ANALYZE, parallel execution, `AS OF` time travel and HNSW vector search. Its SQL is its own: close to PostgreSQL in places and MySQL in others (upserts, AUTO_INCREMENT). Everything below was checked against the 0.5.0 engine; where this guide and your habits from other databases disagree, this guide is right. For anything not covered, search the docs (search_stoolap_docs) before writing SQL that relies on it.

- CREATE takes only TABLE, INDEX or VIEW: no schemas (`schema.table` fails), triggers, procedures, sequences, users or GRANT.
- Identifiers fold to lower case even when quoted.
- `AS OF` reads recent history only: rows already compacted into cold storage have no versions, and the query errors.

## Types, literals, operators, casts, NULLs, names, params, JSON, dates, vectors

**Types** (no others exist)
| Type | Names accepted |
|---|---|
| INTEGER i64 | INTEGER INT BIGINT SMALLINT TINYINT |
| FLOAT f64 | FLOAT REAL DOUBLE DECIMAL NUMERIC (`(p,s)` allowed, ignored) |
| TEXT | TEXT VARCHAR CHAR STRING (no `(n)`) |
| BOOLEAN | BOOLEAN BOOL |
| TIMESTAMP (UTC) | TIMESTAMP DATETIME DATE TIME (all full timestamps; TIME = time on 1970-01-01) |
| JSON / VECTOR | JSON; VECTOR(N) (dims checked), VECTOR |
- Auto id needs `INTEGER PRIMARY KEY AUTO_INCREMENT`; a plain INTEGER PRIMARY KEY is not auto-filled.

**Literals**: `'it''s'`; backslash escapes are processed (`'\n'`, `'\t'`, so write `'C:\\dir'`). `42`, `3.14`, `1e3`, `TRUE`/`FALSE`, `NULL`. `TIMESTAMP '2025-01-01 12:00:00'`, `DATE '2025-01-01'`.

**Operators**: `= <> != < <= > >=`, `AND OR NOT XOR`, `+ - * / %`, `||`, `LIKE` (case-sensitive), `ILIKE`, `ESCAPE`, `GLOB`, `REGEXP`, `BETWEEN`, `IN`, `IS [NOT] NULL|TRUE|FALSE`, `IS [NOT] DISTINCT FROM`, `& | ^ ~ << >>`, `CASE`, `IIF(c,a,b)`.
- `^` is XOR; power is `POWER(a,b)`. `7/2` = 3; use `7 * 1.0 / 2`. `x/0` = NULL. INTEGER overflow errors.
- `'42' + 1` and `TRUE + 1` are NULL: CAST first. `n = '42'` works (text read as number).
- BOOLEAN column: `b = 1` matches NOTHING; write `WHERE b` / `b = TRUE`. Inserting `1`/`0`/`'yes'` is fine.
- Case-insensitive: `ILIKE`, `LOWER(a) = LOWER(b)`, or `COLLATE(a,'NOCASE') = COLLATE(b,'NOCASE')` (also BINARY, NOACCENT).

**CAST**: `CAST(x AS type)` only, no `(n)`. Bad text → NULL (`'3.7'`/`''` → INTEGER NULL); FLOAT→INTEGER truncates; text→BOOLEAN takes true/t/yes/y/1/false/f/no/n/0. TIMESTAMP→TEXT is `'2024-03-15T14:30:00+00:00'`. TIMESTAMP→INTEGER is NULL: use `EXTRACT(EPOCH FROM ts)`.

**NULLs**: `= NULL` is NULL; `'a' || NULL` is NULL, `CONCAT`/`CONCAT_WS` skip NULL; `NOT IN (.., NULL)` is NULL; `COALESCE IFNULL NULLIF`. ASC puts NULLs last, DESC first; `NULLS FIRST|LAST` ok.

**Names**: case-insensitive even when quoted. Quote with `"x"` or `` `x` ``. A double-quoted name that is no column silently becomes a string. Must quote: key values order group table check primary unique references select from desc limit index default end set case role view begin commit. Fine unquoted: name value type status date time timestamp text user count data year level rank. No `schema.table`.

**Parameters**: `$1`, `?`, or `:name`; one style per statement.

**JSON** (validated on write): `j -> 'k'` → JSON, `j ->> 'k'` → TEXT, `j -> 'arr' -> 0`, chain `j -> 'a' ->> 'b'` (keys, not `$.` paths). `JSON_EXTRACT(j,'$.a[0]')` (strings unquoted), `JSON_TYPE(j[,path])`, `JSON_VALID`, `JSON_KEYS`, `JSON_ARRAY_LENGTH(j[,path])`, `JSON_OBJECT(k,v,..)`, `JSON_ARRAY(..)`. `jcol = '{..}'` matches nothing: filter on `->>`.

**Dates/times**
- Text: `'2024-03-15'`, `'2024-03-15 14:30:45[.fff]'`, `T` form, `Z`/`+02:00`. Seconds required: `'2024-03-15 14:30'` is rejected/NULL.
- `NOW()`, `CURRENT_TIMESTAMP`, `CURRENT_DATE`; `EXTRACT(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|DOW|DOY|WEEK|QUARTER|EPOCH FROM ts)`, `YEAR(ts)`..`SECOND(ts)`.
- `DATE_TRUNC('year|quarter|month|week|day|hour|minute|second', ts)`, `TIME_TRUNC('15m'|'1h'|'24h', ts)`.
- `DATE_ADD(ts, n[, 'unit'])`/`DATE_SUB` (default day), `DATEDIFF(a, b)` = days a−b, `TO_CHAR(ts, 'YYYY-MM-DD HH24:MI:SS')`.
- `INTERVAL '7 days'` or `INTERVAL 7 DAY`, one unit: us ms second(s) minute(s)/min hour(s) day(s) week(s) month(s) year(s). `n * INTERVAL '1 hour'`; `ts + 1` adds a day.
- Left side must be a timestamp: `'2024-03-15' + INTERVAL '1 day'` is NULL. `ts - ts` is TEXT (`'2 days 06:00:00'`); diff seconds via EPOCH.
- `generate_series(a, b[, step])` gives column `value`.

**Vectors**: literal `'[0.1, 0.2, 0.3]'`. `VEC_DISTANCE_L2`, `VEC_DISTANCE_COSINE`, `VEC_DISTANCE_IP`, `a <=> b` (=L2), `VEC_DIMS`, `VEC_NORM`, `VEC_TO_TEXT`. k-NN: `ORDER BY VEC_DISTANCE_COSINE(v, '[..]') LIMIT k`. `CREATE INDEX i ON t(v) USING HNSW WITH (metric = 'cosine')` (metric must match the function). No `EMBED()` here.

```sql
CREATE TABLE ev (id INTEGER PRIMARY KEY AUTO_INCREMENT, "key" TEXT, ok BOOLEAN DEFAULT TRUE, at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, attrs JSON, emb VECTOR(3));
INSERT INTO ev ("key", at, attrs, emb) VALUES ('a', '2024-03-15 14:30:00', '{"brand":"X","specs":{"ram":8},"tags":["x","y"]}', '[1, 0, 0]');
INSERT INTO ev ("key", ok, at, attrs, emb) VALUES ('b', 0, '2024-04-01T09:00:00Z', JSON_OBJECT('brand', 'Y'), '[0, 1, 0]');
SELECT id, attrs ->> 'brand' AS brand, JSON_EXTRACT(attrs, '$.tags[1]') AS tag FROM ev WHERE ok AND CAST(attrs -> 'specs' ->> 'ram' AS INTEGER) > 4;
SELECT id, DATE_TRUNC('month', at) AS m, TO_CHAR(at, 'YYYY-MM-DD') AS d, EXTRACT(EPOCH FROM at) AS epoch, at + INTERVAL '7 days' AS wk FROM ev WHERE at >= '2024-03-01' AND at < NOW() - INTERVAL 1 DAY;
SELECT id, VEC_DISTANCE_COSINE(emb, '[1, 0.1, 0]') AS dist FROM ev ORDER BY dist LIMIT 1;
SELECT CAST('42' AS INTEGER) + 1 AS n, 7 * 1.0 / 2 AS f, POWER(2, 3) AS p, TIMESTAMP '2025-01-31 00:00:00' + 3 * INTERVAL '1 month' AS ts;
```

**Not supported / differs** (→ write instead)
- `SERIAL`, `BIGSERIAL`, `GENERATED AS IDENTITY` → `INTEGER PRIMARY KEY AUTO_INCREMENT`.
- `VARCHAR(n)`, `CHAR(n)`, `INTEGER(11)`, `TIMESTAMP(6)`, `DOUBLE PRECISION`, `UNSIGNED` → bare type name.
- `UUID`, `BLOB`, `BYTEA`, `JSONB`, `ENUM`, `TIMESTAMPTZ`, `INTERVAL` column, `INT8`, `INTEGER[]`/`ARRAY[..]` → TEXT/JSON/TIMESTAMP/VECTOR. No `UUID()`.
- `x::type`, `TRY_CAST`, `CONVERT` → `CAST(x AS type)`.
- `E'..'`, `N'..'`, `X'..'`, `$$..$$`, `[ident]` → `'..'`, `"ident"`. `0x1F`, `1_000` mis-parse silently → `31`, `1000`. `.5` → `0.5`.
- `==`, `**`, `~`, `SIMILAR TO`, `IF()`, `NVL`, `ISNULL()`, `IS UNKNOWN` → `=`, `POWER`, `REGEXP`, `CASE`/`IIF`, `COALESCE`, `IS NULL`.
- `col COLLATE NOCASE` → `COLLATE(col,'NOCASE')`. `COLLATE(x,'NUMERIC')` does not sort naturally → `ORDER BY CAST(x AS INTEGER)`.
- `AT TIME ZONE`, `DATE_PART`, `STRFTIME`, `DATE_FORMAT`, `TO_DATE`, `TO_TIMESTAMP`, `FROM_UNIXTIME`, `UNIX_TIMESTAMP`, `AGE`, `LAST_DAY`, `DATE()`, `SYSDATE`, `GETDATE`, `LOCALTIMESTAMP` → EXTRACT/TO_CHAR/DATE_TRUNC/CAST.
- `DATEDIFF('day', a, b)` → `DATEDIFF(b, a)`; `DATE_ADD(ts, INTERVAL ..)` → `ts + INTERVAL '1 day'`.
- `INTERVAL '1 day 2 hours'`, `INTERVAL '1' DAY`, `'01:30:00'`, unit `h`/`hr` → `INTERVAL '26 hours'`. `TIME_TRUNC('1d')` → `'24h'`.
- JSON `#>`, `#>>`, `@>`, `?`; `JSON_SET/INSERT/REPLACE/REMOVE`, `JSON_CONTAINS`, `JSON_UNQUOTE`, `JSON_LENGTH`, `JSON_AGG`/`JSON_ARRAYAGG`, `JSON_EACH`, `JSON_TABLE` → `->`, `->>`, `JSON_EXTRACT`, `JSON_OBJECT`, `JSON_ARRAY`.
- Vector `<->`, `<#>`, `L2_DISTANCE`, `COSINE_DISTANCE` → `VEC_DISTANCE_*`/`<=>`.
- `INSERT INTO t DEFAULT VALUES` → give at least one column.

## Statements: DDL, DML, transactions, commands

**Tables**
- A one-column PK must be INTEGER. For a TEXT key, add `id INTEGER PRIMARY KEY AUTO_INCREMENT` plus `code TEXT NOT NULL UNIQUE`. A composite `PRIMARY KEY(a,b)` takes any types.
- `AUTO_INCREMENT` works only on an INTEGER PK. On any other column it silently stores NULL.
- A rolled-back INSERT still uses up its AUTO_INCREMENT id: after `BEGIN; INSERT … RETURNING id; ROLLBACK` the next insert gets the following id, as with sequences elsewhere. Gaps in ids are normal; never rely on them being consecutive.
- CHECK works on columns and on the table. FK: `c INTEGER REFERENCES p(id) ON DELETE|ON UPDATE CASCADE|SET NULL|RESTRICT|NO ACTION`, or `FOREIGN KEY (c) REFERENCES p(id)`. The target must be the PK or UNIQUE. One column only.
- Auto-created indexes: `unique_<t>_<col>`, `unique_<t>_0` (multi-column), `fk_<t>_<col>`.
- ALTER takes one action: `ADD [COLUMN] c T [NOT NULL DEFAULT v]` | `DROP [COLUMN] c` | `RENAME COLUMN a TO b` | `MODIFY [COLUMN] c T [NOT NULL]` | `RENAME TO n` | `AUTO_INCREMENT = n` | `[DROP] CLUSTER BY`.
- Indexes: `CREATE [UNIQUE] INDEX [IF NOT EXISTS] n ON t (c1, c2) [USING BTREE|HASH|BITMAP|HNSW] [WITH (m=32, ef_construction=400, ef_search=128, metric='cosine')]`.
  - Defaults: BTREE for INTEGER/FLOAT/TIMESTAMP/TEXT, BITMAP for BOOLEAN, HASH for JSON, HNSW for VECTOR.
  - One single-column index per column (a UNIQUE column already has one).
  - Drop with `DROP INDEX [IF EXISTS] n ON t` (`ON t` is required).

```sql
CREATE TABLE cust (id INTEGER PRIMARY KEY AUTO_INCREMENT, email TEXT NOT NULL UNIQUE, credit FLOAT DEFAULT 0 CHECK (credit >= 0), tag TEXT, at TIMESTAMP DEFAULT NOW());
CREATE TABLE ord (id INTEGER PRIMARY KEY, cust_id INTEGER REFERENCES cust(id) ON DELETE CASCADE, lo INTEGER, hi INTEGER, CHECK (lo < hi));
INSERT INTO cust (email) VALUES ('a@x'), ('b@x') RETURNING id;
ALTER TABLE cust ADD COLUMN tier TEXT NOT NULL DEFAULT 'basic';
ALTER TABLE cust RENAME COLUMN tier TO level;
CREATE INDEX idx_tag ON cust (tag) USING HASH;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ct ON ord (cust_id, lo);
DROP INDEX idx_tag ON cust;
DROP TABLE cust CASCADE;
```

**DML**
- Upsert: `ON CONFLICT [(cols)] DO NOTHING`, `ON CONFLICT (cols) DO UPDATE SET c = EXCLUDED.c [WHERE ...]`, or `ON DUPLICATE KEY UPDATE c = EXCLUDED.c`. A bare column means the existing row.
- RETURNING (aliases allowed) works on INSERT, UPDATE, DELETE and upsert. Use it to read AUTO_INCREMENT ids.
- UPDATE and DELETE work on one table: join through subqueries. `DELETE FROM t AS x` is allowed. UPDATE takes no alias: write `t.col`.
- `_rowid_` is the INTEGER PK, or an engine id when there is no PK. `SELECT *` hides it.
- `TRUNCATE [TABLE] t` cannot be rolled back and resets AUTO_INCREMENT.
- `COPY t FROM 'path' [WITH (FORMAT CSV|JSON, HEADER true, DELIMITER '|', NULL 'NA')]` only imports and cannot run inside BEGIN.
- Views: `CREATE VIEW [IF NOT EXISTS] v AS ...`. They are read-only and take no parameters. Recreate one after its `SELECT *` table gains a column.

```sql
CREATE TABLE stock (id INTEGER PRIMARY KEY, sku TEXT UNIQUE, qty INTEGER DEFAULT 0);
CREATE TABLE feed (sku TEXT, qty INTEGER);
INSERT INTO stock VALUES (1, 'a', 5), (2, 'b', DEFAULT);
INSERT INTO feed VALUES ('a', 3), ('c', 7);
INSERT INTO stock VALUES (1, 'a', 2) ON CONFLICT (id) DO UPDATE SET qty = qty + EXCLUDED.qty RETURNING *;
INSERT INTO stock (id, sku) VALUES (2, 'b') ON DUPLICATE KEY UPDATE qty = 99;
INSERT INTO stock (id, sku, qty) SELECT 10 + qty, sku, qty FROM feed ON CONFLICT (sku) DO UPDATE SET qty = EXCLUDED.qty;
UPDATE stock SET qty = (SELECT f.qty FROM feed f WHERE f.sku = stock.sku) WHERE sku IN (SELECT sku FROM feed) RETURNING id, qty AS new_qty;
DELETE FROM stock AS s WHERE NOT EXISTS (SELECT 1 FROM feed f WHERE f.sku = s.sku) RETURNING _rowid_;
CREATE VIEW low AS SELECT id, sku FROM stock WHERE qty < 5;
```

**Transactions and AS OF**
- `BEGIN [TRANSACTION] [ISOLATION LEVEL READ COMMITTED|SNAPSHOT]`. REPEATABLE READ and SERIALIZABLE run as SNAPSHOT. `SET isolation_level = 'SNAPSHOT'` sets the session default.
- Savepoints: `SAVEPOINT s`, `ROLLBACK TO [SAVEPOINT] s`, `RELEASE [SAVEPOINT] s`.
- A failing statement inside BEGIN undoes only itself. The transaction stays open (unlike PostgreSQL).
- ROLLBACK undoes CREATE TABLE, but not ALTER, CREATE INDEX or CREATE VIEW.
- Time travel: `FROM t AS OF TIMESTAMP '...' [AS x]` or `AS OF TRANSACTION n`.
  - Works on tables only (a JOIN side is fine). The alias goes after AS OF.
  - A timestamp with no offset is read as UTC.
  - History starts at the last open. Asking for a point before that is an error.

```sql
CREATE TABLE acct (id INTEGER PRIMARY KEY, bal INTEGER);
BEGIN TRANSACTION ISOLATION LEVEL SNAPSHOT;
INSERT INTO acct VALUES (1, 100);
SAVEPOINT sp;
UPDATE acct SET bal = 0 WHERE id = 1;
ROLLBACK TO SAVEPOINT sp;
COMMIT;
SELECT c.bal, h.bal AS old_bal FROM acct c JOIN acct AS OF TIMESTAMP NOW() AS h ON h.id = c.id;
```

**Introspection**
- `SHOW TABLES`, `SHOW VIEWS`, `SHOW CREATE TABLE|VIEW x`.
- `SHOW INDEXES FROM t` returns name, column, index_type, is_unique and options. The PK is not listed.
- `DESCRIBE t` (or `DESC t`) returns Field, Type, Null, Key (PRI/UNI/MUL) and Default.
- `ANALYZE [t]` fills `_sys_table_stats` and `_sys_column_stats`.
- `PRAGMA x [= v]` reads or sets query_timeout (ms), checkpoint_interval, checkpoint, snapshot, vacuum, memory_stats or verify. An unknown PRAGMA is a silent no-op.
- EXPLAIN returns one `plan` column with an indented tree; `else` lines are fallbacks.
- EXPLAIN ANALYZE runs the statement (writes too), adds `(actual time=…, rows=N)` to the top line and a final `Paths:` line.

```sql
CREATE TABLE m (id INTEGER PRIMARY KEY, v FLOAT);
CREATE INDEX idx_v ON m (v);
INSERT INTO m VALUES (1, 1.5), (2, 3.5);
ANALYZE m;
SELECT column_name, distinct_count FROM _sys_column_stats WHERE table_name = 'm';
PRAGMA query_timeout = 5000;
EXPLAIN SELECT id FROM m WHERE v > 2;
```

**0.5.0 changes**
- A TEXT index without USING is now BTREE (it was HASH).
- DROP TABLE is refused while an FK references the table; use `DROP TABLE t CASCADE`.
- Table CHECK is now enforced.
- ADD COLUMN refuses CHECK, UNIQUE, PK, AUTO_INCREMENT and REFERENCES. On a table with rows, NOT NULL needs a non-NULL DEFAULT.
- DROP COLUMN and MODIFY refuse the PK and FK columns.
- New: `ALTER TABLE t AUTO_INCREMENT = n`, `PRAGMA query_timeout`, `_rowid_`, UPDATE of an INTEGER PK.
- Writing a column twice in one statement, or text after a statement, is now an error.

**Not supported / differs**
- `SERIAL` and `IDENTITY`: use INTEGER PRIMARY KEY AUTO_INCREMENT.
- `VARCHAR(n)`, `CHAR(n)`, `DOUBLE PRECISION`, `TIMESTAMPTZ`, `BLOB`, `JSONB`, `UUID`: use TEXT, FLOAT, TIMESTAMP or JSON.
- Generated columns: put the expression in a view.
- TEMP tables, `CREATE SCHEMA`, `schema.table`, sequences, `COMMENT ON`, composite FK, `ON DELETE SET DEFAULT`: not supported.
- `CONSTRAINT name`: write the constraint without a name.
- `ALTER COLUMN ...` and `CHANGE COLUMN`: use MODIFY COLUMN.
- `ADD CONSTRAINT`, `ADD PRIMARY KEY`, column `IF [NOT] EXISTS`, comma-separated actions: run one ALTER per action.
- `RENAME a TO b`: write `RENAME COLUMN a TO b`.
- ADD COLUMN `DEFAULT 0 NOT NULL` fails: write `NOT NULL DEFAULT 0`.
- `DROP TABLE a, b`: one table per DROP.
- Index `CONCURRENTLY`, `WHERE` (partial), expression and `DESC` indexes, and unnamed indexes: not supported.
- `CREATE OR REPLACE VIEW`: use DROP VIEW IF EXISTS, then CREATE VIEW.
- Materialized views, `ALTER VIEW`, `v(a,b)` column lists and writing to views: not supported.
- `INSERT OR REPLACE/IGNORE`, `INSERT IGNORE`, `REPLACE INTO`, `UPSERT`, `MERGE`: use ON CONFLICT.
- `ON CONFLICT ON CONSTRAINT`: list the columns instead. `VALUES(c)`: use `EXCLUDED.c`.
- `DEFAULT VALUES` and `INSERT ... SET`: use `VALUES (DEFAULT, ...)`.
- `UPDATE ... FROM/JOIN`, `DELETE ... USING`, UPDATE/DELETE with `LIMIT`, `SET (a,b) = (...)`: use subqueries.
- `LAST_INSERT_ID()`: use RETURNING.
- `START TRANSACTION`, `BEGIN WORK`, `END`, `READ ONLY`, `SET TRANSACTION`: use BEGIN or `SET isolation_level`.
- `t AS x AS OF ...` and `FOR SYSTEM_TIME`: write `t AS OF ... AS x`.
- `COPY ... TO`, `COPY (query)`, `WITH CSV HEADER`: COPY only imports, with options in `WITH (...)`.
- `PRAGMA table_info`, `SHOW COLUMNS`, `SHOW DATABASES`, `information_schema`, `sqlite_master`: use DESCRIBE, SHOW TABLES or SHOW INDEXES.
- `EXPLAIN (FORMAT ...)`, `EXPLAIN QUERY PLAN`, `EXPLAIN VERBOSE`: use plain EXPLAIN.

## Functions (this is the complete list; nothing else exists)

Names are case-insensitive. NULL in gives NULL out. Positions are 1-based.

**String**: `UPPER(s)` `LOWER(s)` `LENGTH(s)`=`CHAR_LENGTH` · `CONCAT(a, ...)` (skips NULL; `a || b` is NULL if either is NULL) · `CONCAT_WS(sep, a, ...)` · `SUBSTRING(s, start[, len])`=`SUBSTR` (negative start counts from the end; no FROM/FOR) · `LEFT(s, n)` `RIGHT(s, n)` · `TRIM(s[, chars])` `LTRIM` `RTRIM` (no `BOTH x FROM`) · `REPLACE(s, from, to)` `REVERSE` `REPEAT(s, n)` · `LPAD(s, len[, pad])` `RPAD` · `SPLIT_PART(s, delim, n)` (n>=1) · `POSITION(sub IN s)`, `STRPOS(s, sub)`, `INSTR(s, sub)`, `LOCATE(sub, s[, from])` (0 = not found) · `STARTS_WITH(s, p)` `ENDS_WITH` `CONTAINS(s, sub)` give BOOLEAN · `CHAR(code)` · `COLLATE(s, 'NOCASE'|'NOACCENT'|'BINARY'|'NUMERIC')` returns the normalized string. Operators: LIKE, ILIKE, GLOB, `s REGEXP 'pat'` (=RLIKE).

**Math**: `ABS` `SIGN` · `ROUND(x[, d])` (half away from zero, d may be negative, returns FLOAT) · `FLOOR` `CEIL`=`CEILING` · `TRUNC(x[, d])`=`TRUNCATE` · `MOD(a, b)` = `a % b` · `POWER(b, e)`=`POW` · `SQRT` · `LOG(x)` is base 10, `LOG(base, x)` · `LOG10` `LOG2` `LN` `EXP` · `PI()` `RANDOM()` (0..1) · `SIN` `COS` `TAN`. `7 / 2` = 3, `7.0 / 2` = 3.5, `x / 0` = NULL. `1 + '2'` is NULL, so CAST text first.

**Date/time** (TIMESTAMP, UTC; date strings are accepted as arguments): `NOW()`=`CURRENT_TIMESTAMP` · `CURRENT_DATE` (midnight TIMESTAMP) · `CURRENT_TIME` (TEXT) · `DATE_TRUNC('year'|'quarter'|'month'|'week'|'day'|'hour'|'minute'|'second', ts)` (weeks start Monday) · `TIME_TRUNC('15m'|'1h'|'30s', ts)` · `EXTRACT(F FROM ts)` gives INTEGER; F is a bare keyword: YEAR MONTH DAY HOUR MINUTE SECOND MILLISECOND MICROSECOND DOW (0=Sun) ISODOW DOY WEEK ISOWEEK QUARTER EPOCH · `YEAR(ts)` `MONTH` `DAY` `HOUR` `MINUTE` `SECOND` · `DATE_ADD(ts, n[, 'unit'])`, `DATE_SUB(...)`: n is an INTEGER, unit defaults to 'day': year month week day hour minute second millisecond microsecond (or plural); no 'quarter'; month ends are clamped · `DATEDIFF(end, start)`=`DATE_DIFF`: whole 24h days, 2 args only · `TO_CHAR(ts, fmt)`, patterns in UPPERCASE only: YYYY YY MM MON Mon MONTH Month DD DY Dy DAY Day HH24 HH12 MI SS MS AM; `TO_CHAR(num, '9,999.99')`. Arithmetic: `ts + INTERVAL '2 hours'`, `ts - INTERVAL '7 days'`, one unit per interval. The left side must be a TIMESTAMP (`'2024-01-01' + INTERVAL ...` is NULL). `ts1 - ts2` gives TEXT ('1 days 01:00:00'); for numbers use `EXTRACT(EPOCH FROM a) - EXTRACT(EPOCH FROM b)`.

**Conditional**: `COALESCE(a, ...)` `NULLIF(a, b)` `IFNULL(a, b)` `IIF(cond, a, b)` `GREATEST(...)` `LEAST(...)` (skip NULLs) · CASE.

**Type/cast**: `CAST(x AS INTEGER|BIGINT|FLOAT|DOUBLE|NUMERIC|TEXT|VARCHAR|BOOLEAN|TIMESTAMP|DATE|JSON|VECTOR)`: no `(n)` parameters (`VARCHAR(10)`, `DECIMAL(10,2)`, `VECTOR(3)` are parse errors), no `::`. A failed cast gives NULL. FLOAT to INTEGER truncates. `CAST(int AS TIMESTAMP)` reads nanoseconds. `TYPEOF(x)` gives 'INTEGER' 'FLOAT' 'TEXT' 'BOOLEAN' 'TIMESTAMP' 'JSON' 'VECTOR' or 'NULL'.

**JSON** (paths look like `$.a.b[0]`): `JSON_EXTRACT(j, path)` (scalars come back typed, missing paths give NULL) · `j -> 'k'` / `j -> 0` (JSON, can be chained), `j ->> 'k'` (TEXT); these take a key or an index, not a `$` path · `JSON_ARRAY_LENGTH(j[, path])` `JSON_ARRAY(v, ...)` `JSON_OBJECT(k, v, ...)` `JSON_TYPE`=`JSON_TYPEOF` `JSON_VALID(s)` (1/0) `JSON_KEYS(j)`.

**Hash**: `MD5` `SHA1` `SHA256` `SHA384` `SHA512` (hex TEXT), `CRC32` (INTEGER).

**Vector**: `VEC_DISTANCE_L2(a, b)` `VEC_DISTANCE_COSINE` `VEC_DISTANCE_IP` (negative dot product) `VEC_DIMS(v)` `VEC_NORM(v)` `VEC_TO_TEXT(v)`; a literal `'[1,0,0]'` works as a vector. There are no `<->` operators.

**System**: `VERSION()` `SLEEP(sec)` `CURRENT_TRANSACTION_ID()` (NULL outside a transaction).

**Aggregate**: `COUNT(*)` `COUNT([DISTINCT] x)` `SUM` `AVG` `MIN` `MAX` `FIRST(x [ORDER BY k])` `LAST(...)` `MEDIAN` `STDDEV`=`STDDEV_SAMP` `STDDEV_POP` `VARIANCE`=`VAR_SAMP` `VAR_POP` · `STRING_AGG([DISTINCT] x[, sep] [ORDER BY k])`=`GROUP_CONCAT` (default separator ',', no SEPARATOR keyword) · `ARRAY_AGG([DISTINCT] x [ORDER BY k])` gives a JSON array as TEXT and skips NULLs. Every aggregate takes `FILTER (WHERE c)`. `GROUPING(col)` works with ROLLUP, CUBE and GROUPING SETS.

**Window** (OVER is required): `ROW_NUMBER()` `RANK()` `DENSE_RANK()` `NTILE(n)` `PERCENT_RANK()` `CUME_DIST()` `LAG(x[, off[, dflt]])` `LEAD(...)` `FIRST_VALUE(x)` `LAST_VALUE(x)` `NTH_VALUE(x, n)`, plus any aggregate. Frames: `ROWS|RANGE BETWEEN ... AND ...` with UNBOUNDED PRECEDING, n PRECEDING, CURRENT ROW, n FOLLOWING or UNBOUNDED FOLLOWING. With ORDER BY, the default frame ends at the current row, so `LAST_VALUE` needs an explicit full frame. `WINDOW w AS (...)` works. Not supported: GROUPS, EXCLUDE, IGNORE NULLS, QUALIFY (filter in an outer query instead).

**Table-valued**: `GENERATE_SERIES(start, stop[, step])` in FROM returns the column `value` (rename it with `AS g(n)`). Both bounds are inclusive. It works with integers, floats, and dates with a step string ('1 day', '2 hours', '30 min', '1 month'). A step in the wrong direction gives 0 rows. Arguments cannot read other FROM tables (no LATERAL). In a SELECT list it returns a JSON array as TEXT.

### Missing — use instead
- DATE_PART/STRFTIME/DATE_FORMAT → `EXTRACT(F FROM ts)`, `TO_CHAR(ts, 'YYYY-MM')`; DATEDIFF('day',a,b)/TIMESTAMPDIFF/DATEADD/AGE → `DATEDIFF(b, a)`, `DATE_ADD(ts, n, 'unit')`, epoch subtraction
- DATE()/TIME()/DATETIME()/TO_DATE/TO_TIMESTAMP/MAKE_DATE → `CAST(x AS TIMESTAMP)`, `DATE_TRUNC('day', x)`; FROM_UNIXTIME(s) → `DATE_ADD('1970-01-01', s, 'second')`; UNIX_TIMESTAMP() → `EXTRACT(EPOCH FROM NOW())`
- LAST_DAY(d) → `DATE_SUB(DATE_ADD(DATE_TRUNC('month', d), 1, 'month'), 1)`; DAYOFWEEK/QUARTER()/WEEK() → `EXTRACT(DOW|QUARTER|WEEK FROM d)`; DAYNAME → `TO_CHAR(d, 'Day')`; GETDATE/SYSDATE/CURDATE/LOCALTIMESTAMP → `NOW()`, `CURRENT_DATE`
- NVL/NVL2/IF()/DECODE → COALESCE, IIF, CASE; TRY_CAST/CONVERT → CAST (NULL on failure)
- REGEXP_REPLACE/REGEXP_MATCHES/REGEXP_LIKE/SIMILAR TO → only boolean `s REGEXP 'p'`
- INITCAP → `UPPER(LEFT(s, 1)) || LOWER(SUBSTRING(s, 2))`; LCASE/UCASE → LOWER/UPPER; MID → SUBSTRING; CHARACTER_LENGTH/LEN/OCTET_LENGTH → LENGTH; BTRIM → TRIM; CHR → CHAR; SPACE(n) → `REPEAT(' ', n)`; none: ASCII, FORMAT, PRINTF, TRANSLATE, HEX, SOUNDEX, SUBSTRING_INDEX, STRING_TO_ARRAY
- RAND → RANDOM; DEGREES/RADIANS → `x * 180 / PI()`, `x * PI() / 180`; CBRT → `POWER(x, 1.0/3)`; none: ATAN, ASIN, ACOS, ATAN2, GCD
- PERCENTILE_CONT/PERCENTILE_DISC/WITHIN GROUP → MEDIAN, or NTILE/PERCENT_RANK in a subquery; MODE() → `GROUP BY x ORDER BY COUNT(*) DESC LIMIT 1`
- JSON_AGG/JSON_GROUP_ARRAY → ARRAY_AGG; none: JSON_SET, JSON_REMOVE, JSON_EACH, JSON_TABLE, UNNEST, JSON_OBJECT_AGG, JSON_BUILD_OBJECT (use JSON_OBJECT)
- BOOL_AND/BOOL_OR → `MIN|MAX(CASE WHEN c THEN 1 ELSE 0 END) = 1`; COUNT_IF → `COUNT(*) FILTER (WHERE c)`; ANY_VALUE → FIRST; MAX_BY(a, b) → `FIRST(a ORDER BY b DESC)`; none: CORR, COVAR_POP, PRODUCT, TOTAL
- UUID()/GEN_RANDOM_UUID() → none (`MD5(CONCAT(RANDOM(), NOW()))` for a random key); none: LAST_INSERT_ID, DATABASE(), USER()

```sql
CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT, day TIMESTAMP, amount FLOAT);
INSERT INTO sales VALUES (1, 'EU', '2024-03-01', 100), (2, 'EU', '2024-03-02', 50), (3, 'US', '2024-03-01', 80), (4, 'EU', '2024-03-05', 70);
SELECT region, STRING_AGG(CAST(id AS TEXT), ', ' ORDER BY day) AS ids, ARRAY_AGG(amount ORDER BY amount DESC) AS amounts, COUNT(*) FILTER (WHERE amount > 60) AS big FROM sales GROUP BY region;
SELECT id, SUM(amount) OVER (PARTITION BY region ORDER BY day) AS running, AVG(amount) OVER (ORDER BY day ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS moving, LAG(amount, 1, 0) OVER (PARTITION BY region ORDER BY day) AS prev, LAST_VALUE(amount) OVER (PARTITION BY region ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_amt FROM sales;
SELECT * FROM (SELECT region, id, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn FROM sales) r WHERE rn = 1;
```

```sql
CREATE TABLE ev (id INTEGER PRIMARY KEY, t0 TIMESTAMP, t1 TIMESTAMP);
INSERT INTO ev VALUES (1, '2024-01-31 08:00:00', '2024-02-02 09:30:00');
SELECT DATE_ADD(t0, 1, 'month') AS m, t0 + INTERVAL '90 minutes' AS p90, DATEDIFF(t1, t0) AS days, (EXTRACT(EPOCH FROM t1) - EXTRACT(EPOCH FROM t0)) / 60 AS mins, DATE_TRUNC('month', t0) AS mstart, TO_CHAR(t0, 'YYYY-MM-DD HH24:MI') AS label FROM ev;
SELECT * FROM ev WHERE t0 >= NOW() - INTERVAL '30 days';
```

```sql
CREATE TABLE orders (id INTEGER PRIMARY KEY, day TIMESTAMP, total FLOAT);
INSERT INTO orders VALUES (1, '2024-01-01', 10), (2, '2024-01-03', 25);
SELECT d.day, COALESCE(SUM(o.total), 0) AS total FROM generate_series('2024-01-01', '2024-01-04', '1 day') AS d(day) LEFT JOIN orders o ON o.day = d.day GROUP BY d.day ORDER BY d.day;
```

## Querying and performance

### Works
- `LIMIT n OFFSET m`, `OFFSET m ROWS FETCH NEXT|FIRST n ROWS ONLY`. LIMIT can be an expression or a subquery.
- ORDER BY: alias, position or expression, with `NULLS FIRST|LAST`. Default puts NULLs last for ASC and first for DESC.
- `DISTINCT ON (k) ... ORDER BY k, x DESC` gives the first row per group. With `SELECT DISTINCT`, each ORDER BY key must be selected.
- `SELECT 1+1;` (no FROM). `(VALUES ..) AS x(a,b)` (default names `column1..`). `generate_series(a,b)` (column `value`).
- `IIF`, `IS [NOT] DISTINCT FROM`, `(a,b) > (1,2)`, `(a,b) IN (SELECT x,y ..)`, `op ANY/ALL (subquery)`.
- WHERE can use a SELECT alias. If it has the same name as a column, the column is used.
- Joins: INNER, LEFT, RIGHT, FULL, CROSS, comma, `USING`, `NATURAL [LEFT|FULL]`. `JOIN` without `ON` is a cross join. A shared bare column name is an error.
- Subqueries (scalar, IN, EXISTS, correlated) work anywhere. A scalar subquery with 2+ rows is an error. `NOT IN` over a NULL returns no rows.
- CTEs: several, chained, `WITH x(c)`, in subqueries, before INSERT/UPDATE/DELETE. `WITH RECURSIVE` needs `UNION ALL` and stops silently after 10,000 iterations.
- `UNION|INTERSECT|EXCEPT [ALL]`. INTERSECT binds tighter.
- GROUP BY on an alias, a position or an expression. HAVING can use a plain aggregate's alias. `COUNT(*) FILTER (WHERE ..)`, `STRING_AGG`, `GROUP_CONCAT`, `ROLLUP`, `CUBE`, `GROUPING SETS`, `GROUPING()`.
- Windows: the usual functions, `WINDOW w`, `ROWS`/`RANGE` frames.

```sql
CREATE TABLE emp (id INTEGER PRIMARY KEY, dept TEXT, boss INTEGER, pay INTEGER);
INSERT INTO emp VALUES (1,'eng',NULL,300),(2,'eng',1,200),(3,'ops',1,150),(4,'ops',3,NULL);
SELECT DISTINCT ON (dept) dept, id, pay FROM emp ORDER BY dept, pay DESC NULLS LAST;
SELECT * FROM (SELECT id, dept, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY id) rn FROM emp) x WHERE rn = 1;
WITH RECURSIVE tree AS (SELECT id, 0 AS lvl FROM emp WHERE boss IS NULL UNION ALL SELECT e.id, t.lvl + 1 FROM emp e JOIN tree t ON e.boss = t.id) SELECT * FROM tree ORDER BY lvl, id;
SELECT dept, GROUPING(dept) AS total, COUNT(*) FILTER (WHERE pay > 160) AS hi FROM emp GROUP BY ROLLUP(dept);
```

### Not supported / differs
- `LIMIT 10, 20`: write `LIMIT 20 OFFSET 10`. `TOP n` and `LIMIT ALL` fail.
- `LATERAL`, `CROSS APPLY`, and a derived table that reads an outer table: use a correlated scalar subquery (`ORDER BY .. LIMIT 1`).
- `QUALIFY` and window functions in WHERE: filter the window alias in a derived table.
- `GROUP BY ALL`, `WITH ROLLUP`, and `GROUP BY g, ROLLUP(x)`: list the columns, or use `GROUPING SETS ((g,x),(g))`.
- Reusing an alias in the same SELECT list, or a HAVING alias of an expression over aggregates (`MAX(v)-MIN(v) AS s`): repeat the expression.
- A bare `VALUES ...;` statement and `IN (VALUES ..)`: use `SELECT * FROM (VALUES ..) x(c)`.
- `(SELECT .. LIMIT 1) UNION (..)`: put each branch in a derived table. `MINUS`: use `EXCEPT`.
- `AS [NOT] MATERIALIZED`, `BETWEEN SYMMETRIC`, `GROUPS` frames and `EXCLUDE` fail. `BETWEEN 30 AND 10` returns no rows.
- `IF()`: use `IIF`. `==`: use `=`. `SIMILAR TO` and `~`: use `REGEXP` or `GLOB`. `DIV`: use `/` (INT/INT gives an integer). `= ANY(ARRAY[..])`: use `IN (..)`.
- `a <=> b` is vector L2 distance, not null-safe equality. Use `IS NOT DISTINCT FROM`.
- `UPDATE .. FROM` and `DELETE .. USING`: use `WHERE id IN (SELECT ..)`.
- `USE INDEX` and `STRAIGHT_JOIN` fail. `/*+ */` is ignored. `CREATE INDEX .. (LOWER(s))` fails.

### Making queries fast in Stoolap
- Plans follow rules, not costs. For an AND, each run reads the index with the fewest matching rows first (no ANALYZE needed). Run `ANALYZE t` after bulk loads, for join order, estimates and zone maps (`_sys_table_stats`, `_sys_column_stats`).
- An index serves `=`, `IN`, ranges and BETWEEN, `LIKE 'pre%'`, and an OR of indexed terms. It does not serve `<>`, `NOT IN`, `NOT (..)`, `IS NULL`, `LIKE '%x'`, `ILIKE`, any function or arithmetic on the column (`c+0`, `LOWER(s)`), or an OR with an unindexed branch. Store a normalized column and index it.
- HASH: equality and IN only (a range gives SeqScan).
- Composite `(a,b,c)`: equality on a leading prefix plus a range on the next column. `b = 2` alone gives SeqScan. `ORDER BY a, b LIMIT n` in one direction is read in index order. Mixed ASC/DESC, or `WHERE a=3 ORDER BY b`, gives TopK.
- `ORDER BY col LIMIT n` with an index or PK on col gives `IndexOrder`/`Keyset`. Without a LIMIT it is always a full `Sort`.
- No WHERE: `COUNT/SUM/MIN/MAX` gives `Stats`/`IndexBound`, and a one-column GROUP BY gives `StorageGrouped`.
- `PARTITION BY` an indexed column plus a LIMIT reads one partition at a time. Other windows process every row first.
- k-NN: `USING HNSW` (metric `l2` by default, or `WITH (metric='cosine')`) and `ORDER BY VEC_DISTANCE_L2(e,'[..]') LIMIT k`. The function must match the metric, or the plan shows `NearestScan` (brute force).
- Joins: an equi-join to a PK or index gives `Index Nested Loop`, else a Hash Join (parallel when large, with no LIMIT). Only INNER chains of 3+ tables are reordered, never with `SELECT *`, outer joins, USING or subquery sides. Write the most selective table first.
- A WHERE that cannot be pushed down runs in parallel at about 10K+ rows, only when the query aggregates or sorts.

```sql
CREATE TABLE o (id INTEGER PRIMARY KEY, cust INTEGER, st TEXT, amt FLOAT);
INSERT INTO o SELECT value, value % 100, CASE WHEN value % 3 = 0 THEN 'open' ELSE 'done' END, value * 1.5 FROM generate_series(1, 3000);
CREATE INDEX o_cust_st ON o(cust, st);
CREATE INDEX o_amt ON o(amt);
ANALYZE o;
EXPLAIN SELECT id FROM o WHERE cust = 5 AND st = 'open';
EXPLAIN ANALYZE SELECT id FROM o ORDER BY amt DESC LIMIT 5;
```

### How to read EXPLAIN
- Access path at the bottom. `else` lines are fallbacks. ANALYZE adds `(actual time, rows)` and `Paths:` (what ran), e.g. `scan.seq|index|parallel_filter`, `join.parallel_hash`, `order_limit.vector_search`.
- Access: `SeqScan t (cond)`, `PkGet`, `UniqueGet`, `IndexGet`, `IndexScan` over `Index i (c =|IN|range|LIKE prefix)` or `CompositeIndex`, `PkKey(s)`, `Intersect, fewest rows first`, `Union`, `Empty unless`, `OneRow`, `Values`, `Function`, `View`, `Derived`, `Cte`, `NearestHnsw|NearestScan`.
- Upper steps: `Filter` (not pushed down), `Project`, `Sort`, `TopN`, `TopK`, `IndexOrder`, `Keyset`, `Limit`, `Distinct(Values)`, `DistinctOn`, `Aggregate .. by`, `StorageFiltered`, `SortedStream`, `Having`, `Window`, `PartitionsByIndex`.
- Joins: `-> Hash Join (build: right)`, `Index Nested Loop (PK)`, `Nested Loop`, `Standard Join`, `Join Cond:`, `-> Seq Scan on t`, `Join order: c, b, a (written a, b, c)`. `rows=` is an estimate. If it is far off, run ANALYZE.
- `Prepared: yes` / `Subqueries: 1: IN over c, once per run` (or `per call: a keyed set..`, batched correlated lookups).

