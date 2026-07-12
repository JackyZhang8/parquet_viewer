use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray, TimestampMillisecondArray};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use parquet::arrow::ArrowWriter;
use parquet::file::properties::WriterProperties;
use tempfile::TempDir;

pub fn write_fixture(path: &Path) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, true),
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Millisecond, None),
            false,
        ),
    ]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int64Array::from_iter_values(0..10)) as ArrayRef,
            Arc::new(StringArray::from(vec![
                Some("zero"),
                Some("one"),
                None,
                Some("three"),
                Some("four"),
                Some("five"),
                Some("six"),
                Some("seven"),
                Some("eight"),
                Some("nine"),
            ])) as ArrayRef,
            Arc::new(TimestampMillisecondArray::from_iter_values(0..10)) as ArrayRef,
        ],
    )
    .unwrap();
    let properties = WriterProperties::builder()
        .set_max_row_group_size(5)
        .build();
    let file = fs::File::create(path).unwrap();
    let mut writer = ArrowWriter::try_new(file, schema, Some(properties)).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
}

pub fn fixture() -> (TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("数据.parquet");
    write_fixture(&path);
    (temp, path)
}
