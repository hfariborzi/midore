//! Desktop only: the tray or menu bar item, the quick-add shortcut, notifications, start at login and updates.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, PhysicalPosition, Rect, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::api::{self, Agenda, Item};
use crate::session::{self, AppState};

const TRAY: &str = "main";
/// The menu bar title and notifications update every minute from the last agenda; the agenda itself is fetched
/// every 5 minutes (or right away after a change). Each fetch reads every connected calendar, so fetching every
/// minute would use up Google's daily quota at a few hundred desktop users.
const REFRESH_EVERY: Duration = Duration::from_secs(60);
const FETCH_EVERY: Duration = Duration::from_secs(300);
/// How long before planned work starts the "up next" notification comes.
const HEADS_UP_SECS: i64 = 120;

/// The menu bar calendar's size, in points.
const MINI_W: f64 = 340.0;
const MINI_H: f64 = 520.0;

/// When the menu bar calendar last hid because it lost focus. Clicking the icon to close it also takes focus
/// away first, so a click right after that hide must not open it again.
#[derive(Default)]
struct MiniHidden(Mutex<Option<Instant>>);

/// Notifications already shown, so each fires once.
#[derive(Default)]
struct Notified(Mutex<HashSet<String>>);

/// Option+Space on macOS, Alt+Space on Windows and Linux.
fn quick_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

pub fn setup<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    app.manage(Notified::default());
    app.manage(MiniHidden::default());
    let handle = app.handle().clone();

    // Closing the window keeps Midore running in the tray or menu bar.
    if let Some(main) = handle.get_webview_window("main") {
        let w = main.clone();
        main.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = w.hide();
            }
        });
    }

    handle.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))?;
    handle.plugin(tauri_plugin_updater::Builder::new().build())?;
    // Launched at login: start in the menu bar without opening the window.
    if std::env::args().any(|a| a == "--background") {
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.hide();
        }
    }

    let shortcut = quick_shortcut();
    handle.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, sc, event| {
                if sc == &shortcut && event.state() == ShortcutState::Pressed {
                    toggle_quick(app);
                }
            })
            .build(),
    )?;
    let _ = handle.global_shortcut().register(quick_shortcut());

    let menu = build_menu(&handle, None)?;
    TrayIconBuilder::with_id(TRAY)
        .icon(Image::from_bytes(include_bytes!("../tray.png"))?)
        .icon_as_template(true)
        .tooltip("Midore")
        .menu(&menu)
        // Left click opens the calendar under the icon; right click (or Control-click) shows the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                let app = tray.app_handle();
                if session::token(app).is_some() {
                    toggle_mini(app, rect);
                } else {
                    show_main(app);
                }
            }
        })
        .build(app)?;

    let bg = handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = bg.notification().request_permission();
        let mut fetched: Option<std::time::Instant> = None;
        loop {
            if fetched.is_none_or(|t| t.elapsed() >= FETCH_EVERY) {
                refresh(&bg).await;
                fetched = Some(std::time::Instant::now());
            } else {
                tick(&bg);
            }
            tokio::time::sleep(REFRESH_EVERY).await;
        }
    });

    #[cfg(not(debug_assertions))]
    {
        let up = handle.clone();
        tauri::async_runtime::spawn(async move { check_for_update(&up).await });
    }
    Ok(())
}

/// Refresh the tray right away (after signing in or out, adding a task, or asking Dori).
pub fn refresh_now<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { refresh(&app).await });
}

/// Between fetches: move the menu bar title and notifications on with the clock, from the last agenda.
fn tick<R: Runtime>(app: &AppHandle<R>) {
    if session::token(app).is_none() {
        return;
    }
    let agenda = app.state::<AppState>().agenda.lock().unwrap().clone();
    if let Some(agenda) = agenda {
        notify(app, &agenda);
        update_tray(app, Some(&agenda));
    }
}

async fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(token) = session::token(app) else {
        update_tray(app, None);
        return;
    };
    let state = app.state::<AppState>();
    if state.me.lock().unwrap().is_none() {
        if let Ok(me) = api::me(&token).await {
            *state.me.lock().unwrap() = Some(me);
        }
    }
    match api::agenda(&token).await {
        Ok(agenda) => {
            notify(app, &agenda);
            if let Ok(json) = serde_json::to_value(&agenda) {
                session::keep_agenda(app, &json);
            }
            *state.agenda.lock().unwrap() = Some(agenda.clone());
            update_tray(app, Some(&agenda));
        }
        Err(api::ApiError::SignedOut) => {
            session::clear(app);
            update_tray(app, None);
        }
        Err(_) => {} // offline: keep showing the last agenda
    }
}

fn parse(t: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(t).ok().map(|d| d.with_timezone(&Local))
}

fn clock(t: &str) -> String {
    parse(t).map(|d| d.format("%-I:%M %p").to_string().to_lowercase()).unwrap_or_default()
}

fn short(title: &str, max: usize) -> String {
    if title.chars().count() <= max {
        title.to_string()
    } else {
        format!("{}…", title.chars().take(max - 1).collect::<String>())
    }
}

/// "Writing · 25m" in the menu bar while something is on, or "Next 2:00 pm" when nothing is.
/// What's on now and what's next, from the agenda's items at this minute (the server's own now/next go stale
/// between fetches).
fn now_next(agenda: &api::Agenda) -> (Option<&Item>, Option<&Item>) {
    let now = Local::now();
    let timed = || agenda.items.iter().filter(|i| !i.all_day);
    let current = timed().find(|i| matches!((parse(&i.start), parse(&i.end)), (Some(s), Some(e)) if s <= now && e > now));
    let next = timed().find(|i| parse(&i.start).is_some_and(|s| s > now));
    (current, next)
}

fn tray_title(agenda: &api::Agenda) -> Option<String> {
    let now = Local::now();
    let (current, next) = now_next(agenda);
    if let Some(cur) = current {
        let left = parse(&cur.end).map(|e| (e - now).num_minutes()).unwrap_or(0);
        return Some(format!("{} · {}m", short(&cur.title, 22), left.max(1)));
    }
    next.map(|n| format!("Next {}", clock(&n.start)))
}

fn now_line(agenda: &api::Agenda) -> String {
    match now_next(agenda).0 {
        Some(cur) => format!("Now: {} · until {}", short(&cur.title, 40), clock(&cur.end)),
        None => "Nothing on right now".to_string(),
    }
}

fn next_line(agenda: &api::Agenda) -> String {
    match now_next(agenda).1 {
        Some(n) => format!("Next: {} · {}", short(&n.title, 40), clock(&n.start)),
        None => "Nothing else today".to_string(),
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, agenda: Option<&api::Agenda>) -> tauri::Result<Menu<R>> {
    let signed_in = session::token(app).is_some();
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let menu = Menu::new(app)?;
    if signed_in {
        let (now, next) = match agenda {
            Some(a) => (now_line(a), next_line(a)),
            None => ("Loading your day…".to_string(), String::new()),
        };
        menu.append(&MenuItem::with_id(app, "now", now, false, None::<&str>)?)?;
        if !next.is_empty() {
            menu.append(&MenuItem::with_id(app, "next", next, false, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(app, "open", "Open Midore", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "quick", "Quick add or ask Dori…", true, Some("Alt+Space"))?)?;
        menu.append(&MenuItem::with_id(app, "copy-link", "Copy booking link", true, None::<&str>)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&CheckMenuItem::with_id(app, "autostart", "Open at login", true, autostart, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "sign-out", "Sign out", true, None::<&str>)?)?;
    } else {
        menu.append(&MenuItem::with_id(app, "open", "Sign in to Midore…", true, None::<&str>)?)?;
        menu.append(&CheckMenuItem::with_id(app, "autostart", "Open at login", true, autostart, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Midore", true, Some("CmdOrCtrl+Q"))?)?;
    Ok(menu)
}

fn update_tray<R: Runtime>(app: &AppHandle<R>, agenda: Option<&api::Agenda>) {
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    if let Ok(menu) = build_menu(app, agenda) {
        let _ = tray.set_menu(Some(menu));
    }
    // The menu bar title is a macOS feature; elsewhere the tooltip carries it.
    let title = agenda.and_then(tray_title);
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(title.as_deref());
    let _ = tray.set_tooltip(Some(title.map(|t| format!("Midore · {t}")).unwrap_or_else(|| "Midore".into())));
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "open" => show_main(app),
        "quick" => toggle_quick(app),
        "copy-link" => copy_booking_link(app),
        "autostart" => {
            let al = app.autolaunch();
            let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
            update_tray(app, app.state::<AppState>().agenda.lock().unwrap().as_ref());
        }
        "sign-out" => {
            crate::sign_out_inner(app);
            show_main(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Copy the booking link (menu item and the Booking widget).
pub fn copy_booking_link<R: Runtime>(app: &AppHandle<R>) {
    let link = app.state::<AppState>().me.lock().unwrap().as_ref().map(|m| m.booking_url.clone());
    if let Some(link) = link {
        if app.clipboard().write_text(link.clone()).is_ok() {
            let _ = app.notification().builder().title("Booking link copied").body(link).show();
        }
    }
}

/// Open the quick window (from a widget), even if it is already visible.
pub fn open_quick<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        toggle_quick(app);
    }
}

/// The quick window: a small box for adding a task or asking Dori, from anywhere.
fn toggle_quick<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("quick") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.center();
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }
    let built = WebviewWindowBuilder::new(app, "quick", WebviewUrl::App("quick.html".into()))
        .title("Midore")
        .inner_size(600.0, 210.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build();
    if let Ok(w) = built {
        let w2 = w.clone();
        w.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                let _ = w2.hide();
            }
        });
    }
}

pub fn hide_mini<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.hide();
    }
}

/// The menu bar calendar: a small panel under the icon with a month and the chosen day's events and planned
/// work. It hides when it loses focus, like a menu.
fn toggle_mini<R: Runtime>(app: &AppHandle<R>, icon: Rect) {
    let just_hidden = app.state::<MiniHidden>().0.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(350));
    let window = match app.get_webview_window("mini") {
        Some(w) => {
            if w.is_visible().unwrap_or(false) || just_hidden {
                let _ = w.hide();
                return;
            }
            w
        }
        None => {
            let built = WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("mini.html".into()))
                .title("Midore")
                .inner_size(MINI_W, MINI_H)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .visible(false)
                .build();
            let Ok(w) = built else { return };
            let (w2, handle) = (w.clone(), app.clone());
            w.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = w2.hide();
                    *handle.state::<MiniHidden>().0.lock().unwrap() = Some(Instant::now());
                }
            });
            w
        }
    };
    place_under(app, &window, icon);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Centre the panel under the menu bar icon, kept inside the screen.
fn place_under<R: Runtime>(app: &AppHandle<R>, window: &tauri::WebviewWindow<R>, icon: Rect) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let pos: PhysicalPosition<f64> = icon.position.to_physical(scale);
    let size: tauri::PhysicalSize<f64> = icon.size.to_physical(scale);
    let monitor = app.monitor_from_point(pos.x, pos.y).ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(scale);
    let (w, h) = (MINI_W * scale, MINI_H * scale);
    let gap = 6.0 * scale;
    let mut x = pos.x + size.width / 2.0 - w / 2.0;
    // Windows and Linux trays sit at the bottom of the screen: open above the icon there.
    let mut y = if cfg!(target_os = "macos") { pos.y + size.height + gap } else { pos.y - h - gap };
    if let Some(m) = &monitor {
        let (mx, my) = (m.position().x as f64, m.position().y as f64);
        let (mw, mh) = (m.size().width as f64, m.size().height as f64);
        x = x.clamp(mx + gap, mx + mw - w - gap);
        y = y.clamp(my, my + mh - h);
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Planned work: a heads-up just before it starts, and "how did it go?" when it ends. Alerts set on tasks and
/// reminders, and the morning brief, fire at their time.
fn notify<R: Runtime>(app: &AppHandle<R>, agenda: &Agenda) {
    let (items, alerts) = (&agenda.items, &agenda.alerts);
    let now = Local::now();
    let notified = app.state::<Notified>();
    let mut seen = notified.0.lock().unwrap();
    if let Some(brief) = &agenda.brief {
        let due = parse(&brief.at).map(|at| (now - at).num_seconds());
        if due.is_some_and(|s| (0..=REFRESH_EVERY.as_secs() as i64 * 2).contains(&s)) && seen.insert(brief.id.clone()) {
            let _ = app.notification().builder().title(brief.title.clone()).body(brief.body.clone()).show();
        }
    }
    for alert in alerts.iter() {
        let Some(at) = parse(&alert.at) else { continue };
        let since = (now - at).num_seconds();
        if (0..=REFRESH_EVERY.as_secs() as i64 * 2).contains(&since) && seen.insert(alert.id.clone()) {
            let _ = app.notification().builder().title(alert.title.clone()).body("Reminder from Midore").show();
        }
    }
    for item in items.iter().filter(|i| i.kind == "task" && i.state.as_deref() == Some("open")) {
        let (Some(start), Some(end)) = (parse(&item.start), parse(&item.end)) else { continue };
        let soon = (start - now).num_seconds();
        if (0..=HEADS_UP_SECS).contains(&soon) && seen.insert(format!("start:{}", item.id)) {
            let _ = app.notification().builder().title(format!("Up next: {}", item.title)).body(format!("Planned until {}", clock(&item.end))).show();
        }
        let since_end = (now - end).num_seconds();
        if (0..=REFRESH_EVERY.as_secs() as i64 * 2).contains(&since_end) && seen.insert(format!("end:{}", item.id)) {
            let _ = app
                .notification()
                .builder()
                .title(format!("How did it go? {}", item.title))
                .body("Open Midore to mark it done, partly done or not done.")
                .show();
        }
    }
    if seen.len() > 500 {
        seen.clear();
    }
}

#[cfg(not(debug_assertions))]
async fn check_for_update<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_updater::UpdaterExt;
    // Builds without an updater key (local and CI test builds) simply skip this.
    let Ok(updater) = app.updater() else { return };
    if let Ok(Some(update)) = updater.check().await {
        if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
            let _ = app
                .notification()
                .builder()
                .title("Midore was updated")
                .body(format!("Version {} is ready. It starts the next time you open Midore.", update.version))
                .show();
        }
    }
}
