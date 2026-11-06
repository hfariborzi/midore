use serde::de::DeserializeOwned;
use std::path::PathBuf;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(app: &AppHandle<R>, _api: PluginApi<R, C>) -> crate::Result<MidoreWidgets<R>> {
    Ok(MidoreWidgets(app.clone()))
}

pub struct MidoreWidgets<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

/// Where the widget extension or provider looks for the session file, if this platform has widgets.
fn session_file() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        return Some(PathBuf::from(home).join("Library/Group Containers/9437GLFKZ8.app.midore/session.json"));
    }
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var_os("LOCALAPPDATA")?;
        return Some(PathBuf::from(local).join("Midore").join("widgets").join("session.json"));
    }
    #[allow(unreachable_code)]
    None
}

impl<R: Runtime> MidoreWidgets<R> {
    /// Phones only; computers don't watch places.
    pub fn set_place_alerts(&self, _fences: Vec<PlaceFence>) -> crate::Result<bool> {
        Ok(true)
    }

    pub fn set_session(&self, session: Session) -> crate::Result<()> {
        let Some(path) = session_file() else { return Ok(()) };
        if session.token.is_none() {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, serde_json::to_vec(&session)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}
