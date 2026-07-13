use std::collections::HashSet;
use std::ops::ControlFlow;

use sqlparser::ast::{
    Expr, LimitClause, ObjectName, Query, SetExpr, Statement, TableFactor, Visit, Visitor,
};
use sqlparser::dialect::DuckDbDialect;
use sqlparser::parser::Parser;

use crate::error::AppError;

pub(super) const DENIED_EXTERNAL_FUNCTIONS: &[&str] = &[
    "read_parquet",
    "parquet_scan",
    "parquet_metadata",
    "parquet_schema",
    "parquet_file_metadata",
    "parquet_kv_metadata",
    "parquet_bloom_probe",
    "read_csv",
    "read_csv_auto",
    "read_json",
    "read_json_auto",
    "read_json_objects",
    "read_ndjson",
    "read_blob",
    "read_text",
    "read_xlsx",
    "st_read",
    "glob",
    "http_get",
    "http_post",
    "sqlite_scan",
    "sqlite_attach",
    "postgres_scan",
    "postgres_scan_pushdown",
    "postgres_attach",
    "mysql_scan",
    "mysql_attach",
    "iceberg_scan",
    "delta_scan",
    "query",
    "query_table",
];

pub(super) fn validate_user_sql(sql: &str) -> Result<String, AppError> {
    let statements = Parser::parse_sql(&DuckDbDialect {}, sql).map_err(|error| {
        AppError::sql_with_source("The query has invalid SQL syntax", &error.to_string())
    })?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return Err(AppError::Sql(
            "Exactly one read-only SELECT or WITH query is required".into(),
        ));
    };

    let mut validator = PolicyVisitor::default();
    if let ControlFlow::Break(message) = query.visit(&mut validator) {
        return Err(AppError::Sql(message));
    }
    Ok(query.to_string())
}

#[derive(Default)]
struct PolicyVisitor {
    cte_scopes: Vec<HashSet<String>>,
}

impl Visitor for PolicyVisitor {
    type Break = String;

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<Self::Break> {
        if !matches!(query.body.as_ref(), SetExpr::Select(_)) {
            return ControlFlow::Break("Only SELECT query bodies are allowed".into());
        }
        if matches!(
            query.limit_clause.as_ref(),
            Some(
                LimitClause::LimitOffset {
                    offset: Some(_),
                    ..
                } | LimitClause::OffsetCommaLimit { .. }
            )
        ) {
            return ControlFlow::Break("OFFSET is not allowed in preview queries".into());
        }
        if let Some(with) = &query.with {
            self.cte_scopes.push(
                with.cte_tables
                    .iter()
                    .map(|cte| cte.alias.name.value.to_ascii_lowercase())
                    .collect(),
            );
        } else {
            self.cte_scopes.push(HashSet::new());
        }
        ControlFlow::Continue(())
    }

    fn post_visit_query(&mut self, _query: &Query) -> ControlFlow<Self::Break> {
        self.cte_scopes.pop();
        ControlFlow::Continue(())
    }

    fn pre_visit_relation(&mut self, relation: &ObjectName) -> ControlFlow<Self::Break> {
        let Some(name) = single_name(relation) else {
            return ControlFlow::Break(
                "Schema- and catalog-qualified tables are not allowed".into(),
            );
        };
        let name = name.to_ascii_lowercase();
        if name == "data"
            || self
                .cte_scopes
                .iter()
                .rev()
                .any(|scope| scope.contains(&name))
        {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break("The query may only read from data or a CTE".into())
        }
    }

    fn pre_visit_table_factor(&mut self, factor: &TableFactor) -> ControlFlow<Self::Break> {
        match factor {
            TableFactor::Table { args: None, .. } | TableFactor::Derived { .. } => {
                ControlFlow::Continue(())
            }
            _ => ControlFlow::Break("Table functions are not allowed".into()),
        }
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<Self::Break> {
        let Expr::Function(function) = expr else {
            return ControlFlow::Continue(());
        };
        let Some(name) = single_name(&function.name) else {
            return ControlFlow::Break("Qualified function names are not allowed".into());
        };
        let name = name.to_ascii_lowercase();
        if DENIED_EXTERNAL_FUNCTIONS.contains(&name.as_str())
            || name.starts_with("read_csv")
            || name.starts_with("read_json")
            || name.starts_with("http")
        {
            ControlFlow::Break("External file and network functions are not allowed".into())
        } else {
            ControlFlow::Continue(())
        }
    }
}

fn single_name(name: &ObjectName) -> Option<&str> {
    let [part] = name.0.as_slice() else {
        return None;
    };
    part.as_ident().map(|ident| ident.value.as_str())
}
