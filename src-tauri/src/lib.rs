use std::path::PathBuf;

use serde_json::Value;
use tauri::Manager;

use rulevis_app::{handle_request, AppState, ApiFailure};

#[tauri::command(async)]
fn api_request(
    method: String,
    path: String,
    body: Option<Value>,
    state: tauri::State<'_, AppState>,
) -> Result<Value, ApiFailure> {
    handle_request(&state, &method, &path, body)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = match std::env::var_os("CRS_DATA_DIR") {
                Some(directory) => PathBuf::from(directory),
                None => app.path().app_data_dir()?,
            };
            let state = AppState::load(data_dir).map_err(std::io::Error::other)?;
            state.start_background();
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api_request])
        .run(tauri::generate_context!())
        .expect("failed to run Clash RuleVis");
}
