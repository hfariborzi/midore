use serde::{Deserialize, Serialize};

/// What the widgets need to call /api/v1 themselves: the device token (None when signed out) and the server.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub token: Option<String>,
    pub base_url: String,
}

/// Sign-in in an in-app browser sheet (iOS: ASWebAuthenticationSession; Android: a Custom Tab).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub url: String,
    pub scheme: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthReply {
    /// iOS hands back the `midore://` link that ended the sheet. Android returns None: the link arrives as a
    /// normal deep link.
    pub url: Option<String>,
}

/// What's on now, for the iPhone Live Activity (Lock Screen and Dynamic Island).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub title: String,
    /// "event" or "task"
    pub kind: String,
    pub start: String,
    pub end: String,
    pub color: String,
    pub next_title: Option<String>,
    pub next_start: Option<String>,
}

/// A place the phone watches: a notification when the person arrives (or leaves).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceFence {
    pub id: String,
    pub title: String,
    pub body: String,
    pub lat: f64,
    pub lng: f64,
    /// metres
    pub radius: f64,
    pub on_arrive: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaceFencesArgs {
    pub fences: Vec<PlaceFence>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityArgs {
    pub activity: Option<Activity>,
}
