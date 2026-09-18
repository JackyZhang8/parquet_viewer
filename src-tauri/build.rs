fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Bundled DuckDB 1.4.2 uses the Windows Restart Manager API.
        println!("cargo:rustc-link-lib=rstrtmgr");

        // Cargo passes link-lib only to our library target. Examples that use
        // DuckDB directly also need the import library on their linker command.
        if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            println!("cargo:rustc-link-arg-examples=rstrtmgr.lib");
        } else {
            println!("cargo:rustc-link-arg-examples=-lrstrtmgr");
        }
    }
    tauri_build::build()
}
