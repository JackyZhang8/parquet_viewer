use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use arrow_array::{
    ArrayRef, Int64Array, RecordBatch, StringArray, StructArray, TimestampMillisecondArray,
};
use arrow_schema::{DataType, Field, Fields, Schema, TimeUnit};
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

pub fn write_nested_fixture(path: &Path) {
    let city_field = Arc::new(Field::new("city", DataType::Utf8, true));
    let zip_field = Arc::new(Field::new("zip", DataType::Int64, false));
    let profile = Arc::new(StructArray::from(vec![
        (
            city_field.clone(),
            Arc::new(StringArray::from(vec![Some("Paris")])) as ArrayRef,
        ),
        (
            zip_field.clone(),
            Arc::new(Int64Array::from_iter_values([75000])) as ArrayRef,
        ),
    ])) as ArrayRef;
    let schema = Arc::new(Schema::new(vec![Field::new(
        "profile",
        DataType::Struct(Fields::from(vec![city_field, zip_field])),
        true,
    )]));
    let batch = RecordBatch::try_new(schema.clone(), vec![profile]).unwrap();
    let file = fs::File::create(path).unwrap();
    let mut writer = ArrowWriter::try_new(file, schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
}
