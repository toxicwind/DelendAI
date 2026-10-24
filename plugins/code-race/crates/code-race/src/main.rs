//! delend-code-race (rust CLI) — line-racer front end.
//! Same semantics as the bun bin: every line of a script races under the
//! seconds you pass; breach fails fast (and races forge unless --no-race).
//!
//! usage:
//!   delend-code-race <file> [--seconds N] [--no-race] [--json]
//!   delend-code-race --cmd "<script>" [--seconds N] [--json]

use delendai_code_race::{budget_of, race_script, RaceResult};
use std::env;
use std::io; // Write import not needed; io used for stdin
use std::path::Path;

fn help() {
    println!(
        "delend-code-race (rust) — run EVERY line of a script through code-race.\n\n\
         usage: delend-code-race <file> [--seconds N] [--no-race] [--json]\n\
         \tcat script | delend-code-race --stdin [--seconds N]\n\
         \tdelend-code-race --cmd \"<script>\" [--seconds N]\n\n\
         Every line races under N seconds (default 4); breach kills the line\n\
         fast and races forge unless --no-race. With CODE_RACE_DEBUG=1 every\n\
         step prints a tracer line to stderr (no truncation)."
    );
}

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        help();
        return Ok(());
    }
    let mut seconds: u64 = 4;
    let mut no_race = false;
    let mut as_json = false;
    let mut script = String::new();
    let mut file: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--seconds" => {
                seconds = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(4);
                i += 1;
            }
            "--no-race" => no_race = true,
            "--json" => as_json = true,
            "--stdin" => {
                script = {
                    let mut buf = String::new();
                    io::Read::read_to_string(&mut io::stdin(), &mut buf)?;
                    buf
                };
            }
            "--cmd" => {
                script = args.get(i + 1).cloned().unwrap_or_default();
                i += 1;
            }
            a if !a.starts_with('-') && file.is_none() => file = Some(a.to_string()),
            _ => {}
        }
        i += 1;
    }
    if script.is_empty() {
        if let Some(f) = file {
            script = std::fs::read_to_string(Path::new(&f))?;
        }
    }
    if script.trim().is_empty() {
        eprintln!("no script input (pass a file, --stdin, or --cmd)");
        std::process::exit(2);
    }
    let (ok, results) = race_script(&script, seconds, no_race);
    if as_json {
        let all: Vec<RaceResult> = results;
        println!("{}", serde_json::to_string(&all).expect("serialize"));
    } else {
        for (idx, r) in results.iter().enumerate() {
            println!(
                "line {idx}: rc={} timed_out={} ms={}",
                r.rc,
                r.timed_out,
                r.attempts.first().map(|a| a.ms).unwrap_or(0)
            );
            for l in &r.lines {
                println!("  | {l}");
            }
        }
        println!("done: seconds_per_line={} ok={ok}", budget_of(seconds) / 1000);
    }
    std::process::exit(if ok { 0 } else { 1 });
}