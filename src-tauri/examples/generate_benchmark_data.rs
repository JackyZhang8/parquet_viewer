use std::env;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use duckdb::Connection;

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

fn copy(connection: &Connection, query: &str, path: &Path, options: &str) {
    connection
        .execute_batch(&format!(
            "COPY ({query}) TO {} (FORMAT PARQUET, {options})",
            quote(path)
        ))
        .unwrap_or_else(|error| panic!("generate {}: {error}", path.display()));
}

fn main() {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tests/generated"));
    let rows = env::args()
        .nth(2)
        .unwrap_or_else(|| "1000000".into())
        .parse::<u64>()
        .expect("ROWS must be a positive integer");
    assert!(rows > 0, "ROWS must be greater than zero");
    fs::create_dir_all(&output).expect("create output directory");
    let connection = Connection::open_in_memory().expect("open DuckDB");

    copy(
        &connection,
        "SELECT range::BIGINT AS id,
                CASE WHEN range % 7 = 0 THEN NULL ELSE 'name-' || range END AS name,
                CAST(range * 1.25 AS DECIMAL(18,2)) AS amount,
                range % 2 = 0 AS active,
                DATE '2020-01-01' + CAST(range % 365 AS INTEGER) AS created_date,
                TIMESTAMP '2020-01-01 00:00:00' + range * INTERVAL 1 SECOND AS created_at,
                {'sequence': range, 'label': 'nested-' || range} AS nested
         FROM range(100)",
        &output.join("typed-small.parquet"),
        "COMPRESSION ZSTD, ROW_GROUP_SIZE 25",
    );

    let wide_columns = (0..256)
        .map(|index| format!("range + {index} AS column_{index:03}"))
        .collect::<Vec<_>>()
        .join(", ");
    copy(
        &connection,
        &format!("SELECT {wide_columns} FROM range(1000)"),
        &output.join("wide-schema.parquet"),
        "COMPRESSION ZSTD, ROW_GROUP_SIZE 250",
    );

    copy(
        &connection,
        &format!(
            "SELECT range::UBIGINT AS id,
                    'group-' || (range % 1000) AS group_name,
                    CAST((range % 100000) / 100.0 AS DECIMAL(18,2)) AS amount,
                    range % 2 = 0 AS active,
                    TIMESTAMP '2020-01-01' + range * INTERVAL 1 SECOND AS event_time,
                    repeat('payload-', 8) || range AS payload
             FROM range({rows})"
        ),
        &output.join("large.parquet"),
        "COMPRESSION ZSTD, ROW_GROUP_SIZE 122880",
    );

    fs::write(
        output.join("corrupt-footer.parquet"),
        b"not-a-parquet-footer",
    )
    .expect("write corrupt fixture");
    let truncated = output.join("truncated.parquet");
    copy(
        &connection,
        "SELECT range AS id FROM range(10)",
        &truncated,
        "COMPRESSION ZSTD",
    );
    let file = OpenOptions::new()
        .write(true)
        .open(&truncated)
        .expect("open truncated fixture");
    let length = file.metadata().expect("fixture metadata").len();
    file.set_len(length.saturating_sub(6))
        .expect("truncate fixture footer");

    println!(
        "Generated fixtures in {} (large rows: {rows})",
        output.display()
    );
}
