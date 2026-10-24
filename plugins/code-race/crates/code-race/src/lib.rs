//! delendai-code-race — importable sub-4s breach auto-racer primitive.
//!
//! Mirrors the bun lib (`src/lib/race.ts`) contract:
//!   * `race(cmd_line, budget)` — run one command under a budget, fail fast
//!     on breach; on breach optionally shell out to forge borrow.
//!   * `race_script(script, seconds_per_line)` — run EVERY line of a script
//!     through the race primitive; the target is the seconds you pass.
//!
//! Debug-grade: with `CODE_RACE_DEBUG=1` every step prints a tracer line to
//! stderr, whole-line, no truncation.
//!
//! JSON contract (see RACE_JSON_SCHEMA in the bun lib):
//! {"ok":bool,"rc":int,"timedOut":bool,"lines":[str],"winner":str|null,
//!  "attempts":[{"kind":str,"ms":int,"rc":int,"timedOut":bool,"cmd":str}]}
//! `race_json_line` prints exactly that so cross-language wrappers parse one
//! stable shape.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn debug_enabled() -> bool {
    matches!(
        std::env::var("CODE_RACE_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("yes") | Ok("on")
    )
}

fn dbg(args: impl IntoIterator<Item = String>) {
    if !debug_enabled() {
        return;
    }
    eprintln!("[race] {}", args.into_iter().collect::<Vec<_>>().join(" "));
}

#[derive(Serialize, Debug, Clone)]
pub struct Attempt {
    pub kind: String,
    pub ms: u128,
    pub rc: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct RaceResult {
    pub ok: bool,
    pub rc: i32,
    pub timed_out: bool,
    pub lines: Vec<String>,
    pub winner: Option<String>,
    pub attempts: Vec<Attempt>,
}

pub const BUDGET_MS: u64 = 4000;
pub const WINNER_PATH: &str = "/tmp/delend-code-race-winner.json";

/// Split a command line into argv (simple whitespace split, shell-free).
pub fn argv_of(cmd_line: &str) -> Vec<String> {
    cmd_line
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

/// Run one command under `budget_ms`; return rc/timedOut/lines.
fn run_budgeted(cmd_line: &str, budget_ms: u64) -> (i32, bool, Vec<String>, u128) {
    let argv = argv_of(cmd_line);
    let start = Instant::now();
    dbg([
        "shell start".into(),
        format!("cmd={argv:?} budget_ms={budget_ms}"),
    ]);
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    // poll-with-deadline rather than blocking sleep: fail fast at budget
    let deadline = Instant::now() + Duration::from_millis(budget_ms);
    let mut timed_out = false;
    let status = loop {
        match &mut child {
            Ok(c) => match c.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = c.kill();
                        let _ = c.wait();
                        timed_out = true;
                        break None;
                    }
                    std::thread::yield_now();
                }
                Err(_) => break None,
            },
            Err(_) => break None,
        }
    };
    let ms = start.elapsed().as_millis();
    let mut lines: Vec<String> = Vec::new();
    if let Ok(c) = &mut child {
        if let Some(mut out) = c.stdout.take() {
            let mut buf = String::new();
            let _ = std::io::Read::read_to_string(&mut out, &mut buf);
            lines.extend(buf.lines().map(str::to_string));
        }
        if let Some(mut err) = c.stderr.take() {
            let mut buf = String::new();
            let _ = std::io::Read::read_to_string(&mut err, &mut buf);
            lines.extend(buf.lines().map(str::to_string));
        }
    }
    let rc = status.map(|s| s.code().unwrap_or(1)).unwrap_or(124);
    dbg([
        "shell done".into(),
        format!("rc={rc} timed_out={timed_out} ms={ms}"),
    ]);
    (rc, timed_out, lines, ms)
}

/// Race ONE command line under a budget; on breach, optionally race forge.
pub fn race(cmd_line: &str, budget_ms: u64, no_race: bool) -> RaceResult {
    let mut attempts = Vec::new();
    let (rc, timed_out, lines, ms) = run_budgeted(cmd_line, budget_ms);
    attempts.push(Attempt {
        kind: "budget".into(),
        ms,
        rc,
        timed_out: Some(timed_out),
        cmd: Some(cmd_line.to_string()),
    });
    let winner = std::path::Path::new(WINNER_PATH).exists().then(|| WINNER_PATH.to_string());
    if !timed_out {
        return RaceResult {
            ok: rc == 0,
            rc,
            timed_out: false,
            lines,
            winner: None,
            attempts,
        };
    }
    if no_race {
        return RaceResult {
            ok: false,
            rc: 124,
            timed_out: true,
            lines: vec!["budget breached (noRace)".into()],
            winner: None,
            attempts,
        };
    }
    // breach: race forge borrow (best-effort)
    let forge = std::env::var("DELEND_CODERACE_FORGE")
        .unwrap_or_else(|_| "/home/toxic/pens/barn/forge/bin/forge.ts".into());
    let raced = run_budgeted(
        &format!("bun run {forge} borrow {cmd_line:?} --per-source 3"),
        6000,
    );
    attempts.push(Attempt {
        kind: "winner".into(),
        ms: raced.3,
        rc: raced.0,
        timed_out: Some(raced.1),
        cmd: Some(format!("bun run {forge} borrow")),
    });
    RaceResult {
        ok: raced.0 == 0,
        rc: raced.0,
        timed_out: false,
        lines: raced.2,
        winner,
        attempts,
    }
}

/// Run EVERY line of `script` through `race` under `seconds_per_line`.
pub fn race_script(script: &str, seconds_per_line: u64, no_race: bool) -> (bool, Vec<RaceResult>) {
    let results: Vec<RaceResult> = script
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| race(l, seconds_per_line * 1000, no_race))
        .collect();
    let failed = results.iter().filter(|r| r.timed_out || r.rc != 0).count();
    (failed == 0, results)
}

/// Print the race result as one JSON line (stable cross-language contract).
pub fn race_json_line(result: &RaceResult, out: &mut impl Write) -> std::io::Result<()> {
    let s = serde_json::to_string(result).expect("serialize race result");
    writeln!(out, "{s}")
}

/// Tiny env snapshot helper for debug traces.
pub fn env_snapshot() -> HashMap<String, String> {
    ["CODE_RACE_DEBUG", "DELEND_CODERACE_FORGE", "DELEND_CODERACE_WINNER", "PATH", "PWD"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect()
}

pub fn budget_of(seconds: u64) -> u64 {
    seconds.saturating_mul(1000).max(1)
}