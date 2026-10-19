use output_trim::{filter, store};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        // Task 11: hook::post_main()
        ["hook", "post"] => 0,
        // Task 11: hook::session_start_main()
        ["hook", "session-start"] => 0,
        // No args, or anything else: filter mode (args ignored).
        _ => filter::run(
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &store::default_dir(),
        ),
    };
    std::process::exit(code);
}
