// Builds gst/camfix.c (a tiny GStreamer tracer plugin, see the comment there)
// into $OUT_DIR/libgstpenguincamfix.so; src/main.rs embeds it.
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=gst/camfix.c");
    println!("cargo:rerun-if-env-changed=CC");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("libgstpenguincamfix.so");
    let flags = Command::new("pkg-config")
        .args(["--cflags", "--libs", "gstreamer-1.0"])
        .output()
        .expect("pkg-config not found");
    assert!(flags.status.success(), "pkg-config gstreamer-1.0 failed");
    let flags = String::from_utf8(flags.stdout).unwrap();
    let cc = std::env::var("CC").unwrap_or_else(|_| "cc".into());
    let ok = Command::new(cc)
        .args(["-shared", "-fPIC", "-O2", "-Wall", "-o"])
        .arg(&out)
        .arg("gst/camfix.c")
        .args(flags.split_whitespace())
        .status()
        .expect("C compiler not found");
    assert!(ok.success(), "building gst/camfix.c failed");
}
