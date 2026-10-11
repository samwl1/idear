//! The standalone build of Claude's peer. The app ships the same thing as `idear mcp`.

fn main() {
    std::process::exit(idear_mcp::cli(std::env::args().skip(1).collect()));
}
