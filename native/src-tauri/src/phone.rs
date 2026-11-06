//! Phones only: what the app does on its own, without the web page.
//! - Reminders scheduled on the phone, so they arrive with the app closed: the morning brief and Dori's check-ins,
//!   alerts set on tasks and reminders, a heads-up just before planned work starts, and "How did it go?" when it ends.
//! - Alerts on arriving at or leaving a saved place, which the phone watches itself (plugins/widgets).
//! - The Live Activity on iPhone: what's on now, on the Lock Screen and in the Dynamic Island.
//! - An offline copy of the next two days for the start page.
//! It syncs when the app opens or comes back to the front, after signing in, and every few minutes while open.

use std::time::Duration;

use chrono::{DateTime, Local};
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::{NotificationExt, PermissionState, Schedule};

use crate::api::{self, Agenda};
use crate::session;

const HEADS_UP_SECS: i64 = 120;
/// iOS keeps at most 64 pending notifications per app.
const MAX_SCHEDULED: usize = 40;
const SYNC_EVERY: Duration = Duration::from_secs(300);
/// The places last handed to the phone, so they are re-registered only when they change.
static LAST_FENCES: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            sync(&app).await;
            tokio::time::sleep(SYNC_EVERY).await;
        }
    });
}

pub fn sync_now<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { sync(&app).await });
}

async fn sync<R: Runtime>(app: &AppHandle<R>) {
    let Some(token) = session::token(app) else {
        clear(app);
        return;
    };
    match api::agenda_json(&token, 2).await {
        Ok(json) => {
            session::keep_agenda(app, &json);
            if let Ok(agenda) = serde_json::from_value::<Agenda>(json) {
                schedule(app, &agenda);
                live_activity(app, &agenda);
                place_alerts(app, &agenda);
            }
        }
        Err(api::ApiError::SignedOut) => crate::sign_out_inner(app),
        Err(_) => {} // offline: what is scheduled stays scheduled
    }
}

/// Signed out: no reminders and no Live Activity.
pub fn clear<R: Runtime>(app: &AppHandle<R>) {
    cancel_pending(app);
    {
        use tauri_plugin_midore_widgets::MidoreWidgetsExt;
        let _ = app.midore_widgets().set_place_alerts(Vec::new());
        *LAST_FENCES.lock().unwrap() = None;
    }
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_midore_widgets::MidoreWidgetsExt;
        let _ = app.midore_widgets().set_activity(None);
    }
}

/// Hand the place alerts to the phone, which watches the places with the app closed. Only when something changed,
/// so the phone isn't asked to re-register its places every few minutes.
fn place_alerts<R: Runtime>(app: &AppHandle<R>, agenda: &Agenda) {
    use tauri_plugin_midore_widgets::{MidoreWidgetsExt, PlaceFence};
    let fences: Vec<PlaceFence> = agenda
        .place_alerts
        .iter()
        .take(18)
        .map(|p| PlaceFence {
            id: p.id.clone(),
            title: p.title.clone(),
            body: format!("{} {}", if p.on == "leave" { "Leaving" } else { "At" }, p.place),
            lat: p.lat,
            lng: p.lng,
            radius: p.radius.clamp(100.0, 2000.0),
            on_arrive: p.on != "leave",
        })
        .collect();
    let key = serde_json::to_string(&fences).unwrap_or_default();
    let mut last = LAST_FENCES.lock().unwrap();
    if last.as_deref() == Some(key.as_str()) {
        return;
    }
    if matches!(app.midore_widgets().set_place_alerts(fences), Ok(true)) {
        *last = Some(key);
    }
}

fn cancel_pending<R: Runtime>(app: &AppHandle<R>) {
    let n = app.notification();
    if let Ok(pending) = n.pending() {
        // Place alerts (plugins/widgets) aren't numbered and show up as -1: they are replaced separately.
        let ids: Vec<i32> = pending.iter().map(|p| p.id()).filter(|id| *id >= 0).collect();
        if !ids.is_empty() {
            let _ = n.cancel(ids);
        }
    }
}

fn parse(t: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(t).ok().map(|d| d.with_timezone(&Local))
}

fn clock(t: DateTime<Local>) -> String {
    t.format("%-I:%M %p").to_string().to_lowercase()
}

/// A stable notification id for an item and purpose, so a resync replaces rather than duplicates.
fn note_id(item: &str, purpose: u8) -> i32 {
    let mut h: u32 = 2_166_136_261;
    for b in item.bytes().chain([purpose]) {
        h = (h ^ b as u32).wrapping_mul(16_777_619);
    }
    (h & 0x7fff_ffff) as i32
}

fn schedule<R: Runtime>(app: &AppHandle<R>, agenda: &Agenda) {
    let (items, alerts) = (&agenda.items, &agenda.alerts);
    let n = app.notification();
    match n.permission_state() {
        Ok(PermissionState::Granted) => {}
        Ok(PermissionState::Denied) | Err(_) => return,
        Ok(_) => {
            if !matches!(n.request_permission(), Ok(PermissionState::Granted)) {
                return;
            }
        }
    }
    cancel_pending(app);
    let now = Local::now();
    let mut planned = Vec::new();
    for item in items.iter().filter(|i| i.kind == "task" && i.state.as_deref() == Some("open")) {
        let (Some(start), Some(end)) = (parse(&item.start), parse(&item.end)) else { continue };
        let heads_up = start - chrono::Duration::seconds(HEADS_UP_SECS);
        if heads_up > now {
            planned.push((note_id(&item.id, 1), heads_up, format!("Up next: {}", item.title), format!("Planned until {}", clock(end))));
        }
        if end > now {
            planned.push((note_id(&item.id, 2), end, format!("How did it go? {}", item.title), "Open Midore to mark it done, partly done or not done.".to_string()));
        }
    }
    // Alerts the person asked for (and the morning brief) come first when the phone's limit is near.
    let mut asked = Vec::new();
    for brief in agenda.brief.iter().chain(agenda.check_ins.iter()) {
        if let Some(at) = parse(&brief.at).filter(|at| *at > now) {
            asked.push((note_id(&brief.id, 4), at, brief.title.clone(), brief.body.clone()));
        }
    }
    for alert in alerts {
        if let Some(at) = parse(&alert.at).filter(|at| *at > now) {
            asked.push((note_id(&alert.id, 3), at, alert.title.clone(), "Reminder from Midore".to_string()));
        }
    }
    planned.sort_by_key(|p| p.1);
    asked.sort_by_key(|p| p.1);
    let planned: Vec<_> = asked.into_iter().chain(planned).take(MAX_SCHEDULED).collect();
    for (id, at, title, body) in planned {
        let Ok(date) = time::OffsetDateTime::from_unix_timestamp(at.timestamp()) else { continue };
        let _ = n.builder().id(id).title(title).body(body).schedule(Schedule::At { date, repeating: false, allow_while_idle: true }).show();
    }
}

#[allow(unused_variables)]
fn live_activity<R: Runtime>(app: &AppHandle<R>, agenda: &Agenda) {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_midore_widgets::{Activity, MidoreWidgetsExt};
        let activity = agenda.now.as_ref().filter(|i| !i.all_day).map(|i| Activity {
            title: i.title.clone(),
            kind: i.kind.clone(),
            start: i.start.clone(),
            end: i.end.clone(),
            color: i.color.clone(),
            next_title: agenda.next.as_ref().map(|n| n.title.clone()),
            next_start: agenda.next.as_ref().map(|n| n.start.clone()),
        });
        let _ = app.midore_widgets().set_activity(activity);
    }
}
