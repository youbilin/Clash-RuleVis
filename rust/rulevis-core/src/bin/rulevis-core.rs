use std::fs;
use std::process::ExitCode;

use rulevis_core::{
    ensure_workspace_shape, generate_config, parse_share_link, GenerateOptions, Workspace,
};
use serde_json::json;

fn usage() {
    eprintln!(
        "rulevis-core {}\n\
         Usage:\n\
           rulevis-core check <workspace.json>\n\
           rulevis-core generate <workspace.json>\n\
           rulevis-core normalize <workspace.json>\n\
           rulevis-core parse-link <share-link>",
        env!("CARGO_PKG_VERSION")
    );
}

fn read_workspace(path: &str) -> Result<Workspace, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("无法读取 {}：{}", path, error))?;
    let mut workspace: Workspace =
        serde_json::from_str(&text).map_err(|error| format!("工作区 JSON 无效：{}", error))?;
    ensure_workspace_shape(&mut workspace);
    Ok(workspace)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        usage();
        return ExitCode::from(2);
    };

    match command {
        "check" => {
            let Some(path) = args.get(1) else {
                usage();
                return ExitCode::from(2);
            };
            match read_workspace(path) {
                Ok(workspace) => {
                    let generated = generate_config(&workspace, &GenerateOptions::default());
                    let payload = json!({
                        "counts": generated.counts,
                        "issues": generated.issues,
                    });
                    println!("{}", serde_json::to_string_pretty(&payload).unwrap());
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{}", error);
                    ExitCode::FAILURE
                }
            }
        }
        "generate" => {
            let Some(path) = args.get(1) else {
                usage();
                return ExitCode::from(2);
            };
            match read_workspace(path) {
                Ok(workspace) => {
                    let generated = generate_config(&workspace, &GenerateOptions::default());
                    print!("{}", generated.yaml);
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{}", error);
                    ExitCode::FAILURE
                }
            }
        }
        "normalize" => {
            let Some(path) = args.get(1) else {
                usage();
                return ExitCode::from(2);
            };
            match read_workspace(path) {
                Ok(workspace) => {
                    println!("{}", serde_json::to_string_pretty(&workspace).unwrap());
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{}", error);
                    ExitCode::FAILURE
                }
            }
        }
        "parse-link" => {
            let Some(link) = args.get(1) else {
                usage();
                return ExitCode::from(2);
            };
            match parse_share_link(link) {
                Ok(node) => {
                    println!("{}", serde_json::to_string_pretty(&node).unwrap());
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{}", error);
                    ExitCode::FAILURE
                }
            }
        }
        _ => {
            usage();
            ExitCode::from(2)
        }
    }
}
