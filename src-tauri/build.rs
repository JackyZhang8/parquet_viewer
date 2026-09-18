use std::{env, fs, path::PathBuf};

fn main() {
    let windows = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if windows {
        // Bundled DuckDB 1.4.2 uses the Windows Restart Manager API.
        println!("cargo:rustc-link-lib=rstrtmgr");

        // Cargo passes link-lib only to our library target. Examples that use
        // DuckDB directly also need the import library on their linker command.
        if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            println!("cargo:rustc-link-arg-examples=rstrtmgr.lib");
        } else {
            println!("cargo:rustc-link-arg-examples=-lrstrtmgr");
        }

        embed_windows_app_manifest();
    }

    // The Windows application manifest is linked into every artifact above, so
    // keep tauri-build from embedding a second copy into the binaries.
    let windows_attributes = if windows {
        tauri_build::WindowsAttributes::new_without_app_manifest()
    } else {
        tauri_build::WindowsAttributes::new()
    };
    if let Err(error) = tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(windows_attributes),
    ) {
        println!("{error:#}");
        std::process::exit(1);
    }
}

/// Links the Common Controls v6 application manifest into every Windows
/// artifact, including test executables.
///
/// tauri-build only embeds its manifest into `[[bin]]` targets. Unit and
/// integration test executables link the same Tauri/dialog code, which imports
/// `TaskDialogIndirect` and the window subclassing functions from comctl32.dll.
/// Those entry points only exist in Common Controls v6, and Windows only loads
/// that version when the executable carries a manifest that asks for it.
/// Without one the loader falls back to comctl32 5.82 and the process aborts
/// with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) before any test runs.
fn embed_windows_app_manifest() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let manifest_path = manifest_dir.join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest = fs::read_to_string(&manifest_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", manifest_path.display()));

    // RT_MANIFEST (24) with the CREATEPROCESS_MANIFEST_RESOURCE_ID (1). The
    // string fragments are concatenated by the resource compiler, so keep a
    // space between lines to separate XML attributes.
    let mut resource = String::from("1 24\n{\n");
    for line in manifest
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        resource.push_str(&format!("\" {} \"\n", escape_rc_string(line)));
    }
    resource.push_str("}\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let resource_path = out_dir.join("windows-app-manifest.rc");
    fs::write(&resource_path, resource)
        .unwrap_or_else(|error| panic!("failed to write {}: {error}", resource_path.display()));

    if let Err(error) = embed_resource::compile_for_everything(&resource_path, embed_resource::NONE)
        .manifest_required()
    {
        panic!("failed to compile the Windows application manifest resource: {error}");
    }
}

fn escape_rc_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\"\""),
            '\\' => escaped.push_str("\\\\"),
            other => escaped.push(other),
        }
    }
    escaped
}
