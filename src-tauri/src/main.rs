// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    // `idear mcp ...` is Claude's connection, run by Claude over stdio. No window.
    if args.next().as_deref() == Some("mcp") {
        std::process::exit(idear_mcp::cli(args.collect()));
    }
    idear_lib::run()
}
