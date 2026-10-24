use std::path::PathBuf;

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

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

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Clash RuleVis")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "show" {
                show_main_window(app);
            } else if event.id() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    app.manage(tray);
    Ok(())
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
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            api_request,
            hide_main_window,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Clash RuleVis");
}
