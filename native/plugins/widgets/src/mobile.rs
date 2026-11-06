use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_midore_widgets);

pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, api: PluginApi<R, C>) -> crate::Result<MidoreWidgets<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("app.midore.widgets", "WidgetsPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_midore_widgets)?;
    Ok(MidoreWidgets(handle))
}

pub struct MidoreWidgets<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> MidoreWidgets<R> {
    pub fn set_session(&self, session: Session) -> crate::Result<()> {
        self.0.run_mobile_plugin::<serde_json::Value>("setSession", session).map(|_| ()).map_err(Into::into)
    }

    /// Show what's on now as a Live Activity, or end it (None). iPhone only.
    pub fn set_activity(&self, activity: Option<Activity>) -> crate::Result<()> {
        self.0.run_mobile_plugin::<serde_json::Value>("setActivity", ActivityArgs { activity }).map(|_| ()).map_err(Into::into)
    }

    /// Replace the places the phone watches (at most about 18; the system caps them at 20 per app). Returns false
    /// when they couldn't be registered yet (Android, while location permission is missing), so the app tries again.
    pub fn set_place_alerts(&self, fences: Vec<PlaceFence>) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("setPlaceAlerts", PlaceFencesArgs { fences })
            .map(|v| v.get("registered").and_then(|r| r.as_bool()).unwrap_or(true))
            .map_err(Into::into)
    }

    /// Open the sign-in page in a browser sheet over the app. Blocks until the sheet closes on iOS; returns at
    /// once on Android. Call it off the main thread.
    pub fn authenticate(&self, url: String, scheme: String) -> crate::Result<Option<String>> {
        self.0.run_mobile_plugin::<AuthReply>("authenticate", AuthRequest { url, scheme }).map(|r| r.url).map_err(Into::into)
    }
}
