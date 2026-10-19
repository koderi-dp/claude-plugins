fn main() {
    cc::Build::new()
        .file("vendor/everything-sdk/src/Everything.c")
        .include("vendor/everything-sdk/include")
        .warnings(false)
        .compile("everything_sdk");
    for lib in ["user32", "shell32", "advapi32"] {
        println!("cargo:rustc-link-lib={lib}");
    }
    println!("cargo:rerun-if-changed=vendor/everything-sdk");
}
