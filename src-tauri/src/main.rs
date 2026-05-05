// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

#[derive(serde::Serialize)]
struct DisplayZoomResult {
    platform_scale_percent: u32,
    effective_scale_percent: u32,
    logical_width: f64,
    logical_height: f64,
}

fn clamp_scale_percent(value: f64, min: u32, max: u32) -> u32 {
    if !value.is_finite() {
        return 100;
    }
    value.round().clamp(min as f64, max as f64) as u32
}

fn calculate_desktop_display_scale_percent(width: f64, height: f64) -> u32 {
    if width <= 0.0 || height <= 0.0 {
        return 100;
    }

    let width_scale = width / 1600.0;
    let height_scale = height / 1000.0;
    clamp_scale_percent(width_scale.min(height_scale) * 100.0, 75, 100)
}

fn normalize_ui_scale_percent(value: f64) -> u32 {
    clamp_scale_percent(value, 75, 150)
}

fn combine_display_scale_percent(platform_scale_percent: u32, user_scale_percent: u32) -> u32 {
    ((platform_scale_percent as f64 * user_scale_percent as f64) / 100.0).round() as u32
}

fn apply_desktop_display_zoom(
    window: &tauri::WebviewWindow,
    user_scale_percent: f64,
) -> Result<DisplayZoomResult, String> {
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let monitor_scale = window.scale_factor().map_err(|error| error.to_string())?;
    let scale_factor = if monitor_scale.is_finite() && monitor_scale > 0.0 {
        monitor_scale
    } else {
        1.0
    };
    let logical_width = size.width as f64 / scale_factor;
    let logical_height = size.height as f64 / scale_factor;
    let platform_scale_percent =
        calculate_desktop_display_scale_percent(logical_width, logical_height);
    let normalized_user_scale_percent = normalize_ui_scale_percent(user_scale_percent);
    let effective_scale_percent =
        combine_display_scale_percent(platform_scale_percent, normalized_user_scale_percent);

    window
        .set_zoom((effective_scale_percent as f64 / 100.0).clamp(0.5, 3.0))
        .map_err(|error| error.to_string())?;

    Ok(DisplayZoomResult {
        platform_scale_percent,
        effective_scale_percent,
        logical_width,
        logical_height,
    })
}

#[tauri::command]
fn set_desktop_display_zoom(
    window: tauri::WebviewWindow,
    user_scale_percent: f64,
) -> Result<DisplayZoomResult, String> {
    apply_desktop_display_zoom(&window, user_scale_percent)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![set_desktop_display_zoom])
        .setup(|app| {
            if let Some(webview) = app.get_webview_window("main") {
                if let Err(error) = apply_desktop_display_zoom(&webview, 100.0) {
                    eprintln!("Failed to apply initial desktop display scale: {}", error);
                }

                #[cfg(debug_assertions)]
                webview.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        calculate_desktop_display_scale_percent, combine_display_scale_percent,
        normalize_ui_scale_percent,
    };

    #[test]
    fn desktop_auto_scale_matches_default_window_density() {
        assert_eq!(calculate_desktop_display_scale_percent(1280.0, 800.0), 80);
    }

    #[test]
    fn desktop_auto_scale_is_stable_for_large_or_zoomed_viewports() {
        assert_eq!(calculate_desktop_display_scale_percent(1600.0, 1000.0), 100);
        assert_eq!(calculate_desktop_display_scale_percent(1920.0, 1080.0), 100);
    }

    #[test]
    fn user_scale_combines_with_desktop_auto_scale() {
        assert_eq!(normalize_ui_scale_percent(200.0), 150);
        assert_eq!(combine_display_scale_percent(80, 125), 100);
    }
}
