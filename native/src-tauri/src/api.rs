//! The Midore server API for apps (/api/v1 and /api/native on midore.app).

use serde::{Deserialize, Serialize};
use serde_json::json;

/// The server. `MIDORE_URL` overrides it for development (e.g. http://localhost:3000).
pub fn base_url() -> String {
    std::env::var("MIDORE_URL")
        .ok()
        .or_else(|| option_env!("MIDORE_URL").map(String::from))
        .unwrap_or_else(|| "https://midore.app".to_string())
        .trim_end_matches('/')
        .to_string()
}

/// This build's platform, as the server names it.
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "linux"
    }
}

pub fn platform_label() -> &'static str {
    match platform() {
        "macos" => "Mac",
        "windows" => "Windows",
        "ios" => "iPhone",
        "android" => "Android",
        _ => "Linux",
    }
}

#[derive(Debug)]
pub enum ApiError {
    /// The token was refused: the device was disconnected in Settings or the account is gone.
    SignedOut,
    /// The server said no, with a message for the person.
    Message(String),
    /// No connection or an unexpected answer.
    Network(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::SignedOut => write!(f, "You're signed out. Sign in again."),
            ApiError::Message(m) => write!(f, "{m}"),
            ApiError::Network(m) => write!(f, "Can't reach Midore right now ({m})."),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub name: String,
    pub email: String,
    pub timezone: String,
    pub booking_url: String,
    pub dori: DoriInfo,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DoriInfo {
    pub enabled: bool,
    pub character: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: String, // "event" | "task"
    pub id: String,
    pub task_id: Option<i64>,
    pub title: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub color: String,
    pub state: Option<String>,
}

/// An alert the person set on a task or reminder ("remind me at 6").
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: String,
    pub task_id: i64,
    pub title: String,
    pub at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Agenda {
    pub items: Vec<Item>,
    #[serde(default)]
    pub alerts: Vec<Alert>,
    pub now: Option<Item>,
    pub next: Option<Item>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DoriReply {
    pub text: String,
    #[serde(default)]
    pub actions: Vec<String>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(format!("Midore/{} ({})", env!("CARGO_PKG_VERSION"), platform()))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .expect("http client")
}

async fn read<T: serde::de::DeserializeOwned>(res: reqwest::Result<reqwest::Response>) -> Result<T, ApiError> {
    let res = res.map_err(|e| ApiError::Network(e.without_url().to_string()))?;
    let status = res.status();
    if status.as_u16() == 401 {
        return Err(ApiError::SignedOut);
    }
    if !status.is_success() {
        let body: ErrorBody = res.json().await.unwrap_or(ErrorBody { error: None });
        return Err(ApiError::Message(body.error.unwrap_or_else(|| format!("Something went wrong ({status})."))));
    }
    res.json::<T>().await.map_err(|e| ApiError::Network(e.to_string()))
}

pub async fn exchange_code(code: &str) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct TokenReply {
        token: String,
    }
    let r: TokenReply = read(client().post(format!("{}/api/native/token", base_url())).json(&json!({ "code": code })).send().await).await?;
    Ok(r.token)
}

pub async fn webview_code(token: &str) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct CodeReply {
        code: String,
    }
    let r: CodeReply = read(client().post(format!("{}/api/native/webview-code", base_url())).bearer_auth(token).send().await).await?;
    Ok(r.code)
}

pub async fn me(token: &str) -> Result<Me, ApiError> {
    read(client().get(format!("{}/api/v1/me", base_url())).bearer_auth(token).send().await).await
}

pub async fn agenda(token: &str) -> Result<Agenda, ApiError> {
    read(client().get(format!("{}/api/v1/agenda?days=1", base_url())).bearer_auth(token).send().await).await
}

pub async fn add_task(token: &str, title: &str) -> Result<(), ApiError> {
    let _: serde_json::Value = read(client().post(format!("{}/api/v1/tasks", base_url())).bearer_auth(token).json(&json!({ "title": title })).send().await).await?;
    Ok(())
}

pub async fn ask_dori(token: &str, text: &str) -> Result<DoriReply, ApiError> {
    read(client().post(format!("{}/api/v1/dori", base_url())).bearer_auth(token).json(&json!({ "text": text })).send().await).await
}

/// One day for the menu bar calendar (`date` as YYYY-MM-DD, or today), passed through to the page as JSON.
pub async fn day(token: &str, date: Option<&str>) -> Result<serde_json::Value, ApiError> {
    let mut url = reqwest::Url::parse(&format!("{}/api/v1/agenda", base_url())).map_err(|e| ApiError::Network(e.to_string()))?;
    url.query_pairs_mut().append_pair("days", "1");
    if let Some(d) = date {
        url.query_pairs_mut().append_pair("date", d);
    }
    read(client().get(url).bearer_auth(token).send().await).await
}

/// Mark a planned block done (the tick in the menu bar calendar).
pub async fn mark_done(token: &str, task_id: i64, start: &str, end: &str) -> Result<(), ApiError> {
    let body = json!({ "taskId": task_id, "start": start, "end": end, "state": { "status": "done" } });
    let _: serde_json::Value = read(client().post(format!("{}/api/v1/blocks/mark", base_url())).bearer_auth(token).json(&body).send().await).await?;
    Ok(())
}

#[cfg_attr(desktop, allow(dead_code))]
/// The agenda as the server sent it, for keeping an offline copy (`days` 1 to 7, from today).
pub async fn agenda_json(token: &str, days: u8) -> Result<serde_json::Value, ApiError> {
    read(client().get(format!("{}/api/v1/agenda?days={days}", base_url())).bearer_auth(token).send().await).await
}
