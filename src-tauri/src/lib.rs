use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use windows::core::HSTRING;
use windows::Win32::Foundation::{GetLastError, BOOL, ERROR_ALREADY_EXISTS, HWND, LPARAM};
use windows::Win32::UI::Shell::IsUserAnAdmin;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    MessageBoxW, ShowWindow, MB_ICONERROR, MB_OK, SW_HIDE,
};
use windows::Win32::System::Threading::CreateMutexW;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CONFIG_FILE: &str = "zprt-app-config.json";
const REPO_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/Flowseal/zapret-discord-youtube/releases/latest";
const REPO_RELEASE_BY_TAG_URL_PREFIX: &str =
    "https://api.github.com/repos/Flowseal/zapret-discord-youtube/releases/tags/";
const ASSET_PREFIX: &str = "zapret-discord-youtube-";
const AUTOSTART_TASK_NAME: &str = "ZPRT App Autostart";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const TRAY_ID: &str = "main-tray";
const SINGLE_INSTANCE_MUTEX: &str = "Global\\com.timur.zprtapp.single_instance";
const TRAY_MENU_STRATEGY_PREFIX: &str = "tray_strategy::";
const UPDATE_CHECK_INTERVAL_SECS: u64 = 3600;
const UPDATE_TOAST_WINDOW_LABEL: &str = "update-toast";
const UPDATE_TOAST_EVENT: &str = "update-toast-message";
const OPEN_VERSIONS_TAB_EVENT: &str = "open-versions-tab";
const UPDATE_TOAST_WIDTH: f64 = 300.0;
const UPDATE_TOAST_HEIGHT: f64 = 84.0;
const UPDATE_TOAST_MARGIN: i32 = 16;
const UPDATE_TOAST_HIDE_SECS: u64 = 5;
const USER_LISTS_DIR: &str = "user-lists";
const USER_LIST_GENERAL_FILE: &str = "list-general-user.txt";
const USER_LIST_EXCLUDE_FILE: &str = "list-exclude-user.txt";
const USER_LIST_IPSET_EXCLUDE_FILE: &str = "ipset-exclude-user.txt";
const DEBUG_LOG_FILE: &str = "debug_logs.txt";
static CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static DEBUG_MODE_ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct AppFlags {
    is_quitting: Mutex<bool>,
    toast_hide_seq: Mutex<u64>,
}

fn default_true() -> bool {
    true
}

fn config_lock() -> &'static Mutex<()> {
    CONFIG_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    active_version: Option<String>,
    selected_strategy: Option<String>,
    #[serde(default = "default_true")]
    notify_update_available: bool,
    #[serde(default)]
    last_update_notification: Option<String>,
    #[serde(default)]
    debug_mode: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            active_version: None,
            selected_strategy: None,
            notify_update_available: true,
            last_update_notification: None,
            debug_mode: false,
        }
    }
}

fn debug_log_path() -> Result<PathBuf, String> {
    Ok(app_base_dir()?.join(DEBUG_LOG_FILE))
}

fn ensure_debug_log_file() -> Result<(), String> {
    let path = debug_log_path()?;
    if !path.exists() {
        fs::write(path, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn refresh_debug_mode_from_config() {
    let enabled = load_config().map(|c| c.debug_mode).unwrap_or(false);
    DEBUG_MODE_ENABLED.store(enabled, AtomicOrdering::Relaxed);
    if enabled {
        let _ = ensure_debug_log_file();
    }
}

fn debug_log_error(context: &str, error: &str) {
    if !DEBUG_MODE_ENABLED.load(AtomicOrdering::Relaxed) {
        return;
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{ts}] {context}: {error}\n");

    let Ok(path) = debug_log_path() else {
        return;
    };

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };

    let _ = file.write_all(line.as_bytes());
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiState {
    installed_versions: Vec<String>,
    active_version: Option<String>,
    latest_version: Option<String>,
    latest_release_url: Option<String>,
    update_available: bool,
    update_notification_needed: bool,
    strategies: Vec<String>,
    selected_strategy: Option<String>,
    is_running: bool,
    autostart_enabled: bool,
    notify_update_available: bool,
    list_general_user: String,
    list_exclude_user: String,
    ipset_exclude_user: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

fn app_base_dir() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest_dir
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Failed to resolve workspace directory".to_string())
    } else {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        exe.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Failed to resolve executable directory".to_string())
    }
}

fn zapret_root() -> Result<PathBuf, String> {
    let base = app_base_dir()?;
    let root = base.join("zapret");
    if !root.exists() {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    }
    Ok(root)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(app_base_dir()?.join(CONFIG_FILE))
}

fn user_lists_dir() -> Result<PathBuf, String> {
    let dir = app_base_dir()?.join(USER_LISTS_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn user_list_paths() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let dir = user_lists_dir()?;
    let general = dir.join(USER_LIST_GENERAL_FILE);
    let exclude = dir.join(USER_LIST_EXCLUDE_FILE);
    let ipset_exclude = dir.join(USER_LIST_IPSET_EXCLUDE_FILE);

    for path in [&general, &exclude, &ipset_exclude] {
        if !path.exists() {
            fs::write(path, "").map_err(|e| e.to_string())?;
        }
    }

    Ok((general, exclude, ipset_exclude))
}

fn read_user_list_files() -> Result<(String, String, String), String> {
    let (general, exclude, ipset_exclude) = user_list_paths()?;
    Ok((
        read_text_if_exists(&general)?,
        read_text_if_exists(&exclude)?,
        read_text_if_exists(&ipset_exclude)?,
    ))
}

fn with_config_lock<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = config_lock()
        .lock()
        .map_err(|_| "Config lock is poisoned".to_string())?;
    f()
}

fn load_config_unlocked() -> Result<AppConfig, String> {
    let cfg_path = config_path()?;
    if !cfg_path.exists() {
        return Ok(AppConfig::default());
    }

    let mut file = File::open(&cfg_path).map_err(|e| e.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| e.to_string())?;

    serde_json::from_str(&content).map_err(|e| format!("Config parse error: {e}"))
}

fn save_config_unlocked(config: &AppConfig) -> Result<(), String> {
    let cfg_path = config_path()?;
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let mut file = File::create(&cfg_path).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

fn load_config() -> Result<AppConfig, String> {
    with_config_lock(load_config_unlocked)
}

fn read_config<T>(reader: impl FnOnce(&AppConfig) -> Result<T, String>) -> Result<T, String> {
    with_config_lock(|| {
        let config = load_config_unlocked()?;
        reader(&config)
    })
}

fn mutate_config<T>(
    mutator: impl FnOnce(&mut AppConfig) -> Result<T, String>,
) -> Result<T, String> {
    with_config_lock(|| {
        let mut config = load_config_unlocked()?;
        let result = mutator(&mut config)?;
        save_config_unlocked(&config)?;
        Ok(result)
    })
}

fn normalize_version(input: &str) -> String {
    input.trim().trim_start_matches('v').to_string()
}

fn parse_version_for_sort(value: &str) -> Option<Version> {
    Version::parse(value.trim_start_matches('v')).ok()
}

fn list_installed_versions() -> Result<Vec<String>, String> {
    let mut versions = Vec::new();
    for entry in fs::read_dir(zapret_root()?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().is_dir() {
            versions.push(entry.file_name().to_string_lossy().to_string());
        }
    }

    versions.sort_by(|a, b| {
        let va = parse_version_for_sort(a);
        let vb = parse_version_for_sort(b);
        match (va, vb) {
            (Some(va), Some(vb)) => vb.cmp(&va),
            _ => b.cmp(a),
        }
    });
    Ok(versions)
}

fn active_version_dir(config: &AppConfig) -> Result<PathBuf, String> {
    let version = config
        .active_version
        .as_ref()
        .ok_or_else(|| "No active version selected".to_string())?;
    let path = zapret_root()?.join(version);
    if !path.exists() {
        return Err(format!("Active version folder not found: {version}"));
    }
    Ok(path)
}

fn list_strategies_for_version(version: &str) -> Result<Vec<String>, String> {
    let mut strategies = Vec::new();
    let dir = zapret_root()?.join(version);
    if !dir.exists() {
        return Ok(strategies);
    }

    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(name) = path.file_name().map(|x| x.to_string_lossy().to_string()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("general") && lower.ends_with(".bat") {
            strategies.push(name);
        }
    }

    strategies.sort_by(|a, b| natural_sort_cmp(a, b));
    Ok(strategies)
}

fn natural_sort_cmp(left: &str, right: &str) -> Ordering {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let mut i = 0usize;
    let mut j = 0usize;

    while i < left_bytes.len() && j < right_bytes.len() {
        let lc = left_bytes[i];
        let rc = right_bytes[j];

        if lc.is_ascii_digit() && rc.is_ascii_digit() {
            let start_i = i;
            let start_j = j;

            while i < left_bytes.len() && left_bytes[i].is_ascii_digit() {
                i += 1;
            }
            while j < right_bytes.len() && right_bytes[j].is_ascii_digit() {
                j += 1;
            }

            let left_num = &left[start_i..i];
            let right_num = &right[start_j..j];
            let left_trim = left_num.trim_start_matches('0');
            let right_trim = right_num.trim_start_matches('0');

            let left_norm = if left_trim.is_empty() { "0" } else { left_trim };
            let right_norm = if right_trim.is_empty() { "0" } else { right_trim };

            match left_norm.len().cmp(&right_norm.len()) {
                Ordering::Less => return Ordering::Less,
                Ordering::Greater => return Ordering::Greater,
                Ordering::Equal => match left_norm.cmp(right_norm) {
                    Ordering::Less => return Ordering::Less,
                    Ordering::Greater => return Ordering::Greater,
                    Ordering::Equal => {}
                },
            }

            match left_num.len().cmp(&right_num.len()) {
                Ordering::Less => return Ordering::Less,
                Ordering::Greater => return Ordering::Greater,
                Ordering::Equal => {}
            }

            continue;
        }

        let lc_lower = lc.to_ascii_lowercase();
        let rc_lower = rc.to_ascii_lowercase();
        match lc_lower.cmp(&rc_lower) {
            Ordering::Less => return Ordering::Less,
            Ordering::Greater => return Ordering::Greater,
            Ordering::Equal => {
                i += 1;
                j += 1;
            }
        }
    }

    left_bytes.len().cmp(&right_bytes.len())
}

fn zapret_list_file_paths(config: &AppConfig) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let base = active_version_dir(config)?;
    let lists_dir = base.join("lists");
    if !lists_dir.exists() {
        fs::create_dir_all(&lists_dir).map_err(|e| e.to_string())?;
    }
    Ok((
        lists_dir.join(USER_LIST_GENERAL_FILE),
        lists_dir.join(USER_LIST_EXCLUDE_FILE),
        lists_dir.join(USER_LIST_IPSET_EXCLUDE_FILE),
    ))
}

fn sync_user_lists_to_active_version(config: &AppConfig) -> Result<(), String> {
    let (src_general, src_exclude, src_ipset_exclude) = user_list_paths()?;
    let (dst_general, dst_exclude, dst_ipset_exclude) = zapret_list_file_paths(config)?;

    fs::copy(src_general, dst_general).map_err(|e| e.to_string())?;
    fs::copy(src_exclude, dst_exclude).map_err(|e| e.to_string())?;
    fs::copy(src_ipset_exclude, dst_ipset_exclude).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_text_if_exists(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

fn collect_winws_related_pids(sys: &System) -> HashSet<u32> {
    let mut related: HashSet<u32> = sys
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            if process
                .name()
                .to_string_lossy()
                .eq_ignore_ascii_case("winws.exe")
            {
                Some(pid.as_u32())
            } else {
                None
            }
        })
        .collect();

    let mut changed = true;
    while changed {
        changed = false;
        for (pid, process) in sys.processes() {
            if related.contains(&pid.as_u32()) {
                continue;
            }

            if let Some(parent) = process.parent() {
                if related.contains(&parent.as_u32()) {
                    related.insert(pid.as_u32());
                    changed = true;
                }
            }
        }
    }

    related
}

fn is_winws_running() -> bool {
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    !collect_winws_related_pids(&sys).is_empty()
}

fn is_autostart_enabled() -> bool {
    Command::new("schtasks")
        .args(["/Query", "/TN", AUTOSTART_TASK_NAME])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn set_autostart_impl(enabled: bool) -> Result<(), String> {
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let task_command = format!("\"{}\" --autostart", exe.display());
        let output = Command::new("schtasks")
            .args([
                "/Create",
                "/TN",
                AUTOSTART_TASK_NAME,
                "/TR",
                &task_command,
                "/SC",
                "ONLOGON",
                "/RL",
                "HIGHEST",
                "/F",
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(())
        } else {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if error.is_empty() {
                Err("Не удалось создать задачу автозапуска в Планировщике заданий".to_string())
            } else {
                Err(format!(
                    "Не удалось создать задачу автозапуска в Планировщике заданий: {error}"
                ))
            }
        }
    } else {
        let output = Command::new("schtasks")
            .args(["/Delete", "/TN", AUTOSTART_TASK_NAME, "/F"])
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(())
        } else {
            // If task already doesn't exist, treat as success.
            let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
            let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
            let missing = stderr.contains("cannot find")
                || stderr.contains("не удается найти‘")
                || stdout.contains("cannot find")
                || stdout.contains("не удается найти");
            if missing {
                Ok(())
            } else {
                let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if error.is_empty() {
                    Err("Не удалось удалить задачу автозапуска из Планировщика заданий".to_string())
                } else {
                    Err(format!(
                        "Не удалось удалить задачу автозапуска из Планировщика заданий: {error}"
                    ))
                }
            }
        }
    }
}

fn github_client() -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("zprt-app"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));

    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_latest_release() -> Result<GithubRelease, String> {
    match github_client()?
        .get(REPO_LATEST_RELEASE_URL)
        .send()
        .await
        .map_err(|e| e.to_string())
    {
        Ok(response) if response.status().is_success() => {
            response.json::<GithubRelease>().await.map_err(|e| e.to_string())
        }
        Ok(response) => {
            let api_error = format!("GitHub API error: {}", response.status());
            fetch_latest_release_via_html().await.map_err(|html_error| {
                format!("{api_error}. HTML fallback error: {html_error}")
            })
        }
        Err(api_error) => fetch_latest_release_via_html()
            .await
            .map_err(|html_error| format!("{api_error}. HTML fallback error: {html_error}")),
    }
}

async fn fetch_release_by_tag(tag: &str) -> Result<GithubRelease, String> {
    let url = format!("{REPO_RELEASE_BY_TAG_URL_PREFIX}{tag}");
    let response = github_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub API error for tag {tag}: {}",
            response.status()
        ));
    }

    response
        .json::<GithubRelease>()
        .await
        .map_err(|e| e.to_string())
}

fn open_in_browser(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "start", "", target])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn pick_zip_asset(release: &GithubRelease) -> Result<&GithubAsset, String> {
    release
        .assets
        .iter()
        .find(|asset| asset.name.starts_with(ASSET_PREFIX) && asset.name.ends_with(".zip"))
        .ok_or_else(|| "Release asset zapret-discord-youtube-*.zip not found".to_string())
}

fn extract_tag_from_release_url(url: &str) -> Option<String> {
    let marker = "/releases/tag/";
    let pos = url.find(marker)?;
    let mut tag = url[(pos + marker.len())..].to_string();
    if let Some(idx) = tag.find('?') {
        tag.truncate(idx);
    }
    if let Some(idx) = tag.find('#') {
        tag.truncate(idx);
    }
    if tag.is_empty() {
        None
    } else {
        Some(tag)
    }
}

fn parse_assets_from_release_html(html: &str) -> Vec<GithubAsset> {
    let mut assets = Vec::new();
    let mut seen_names = HashSet::new();

    for chunk in html.split("href=\"").skip(1) {
        let Some(end_idx) = chunk.find('"') else {
            continue;
        };
        let href_raw = &chunk[..end_idx];
        let href = href_raw.replace("&amp;", "&");

        if !href.contains("/releases/download/") || !href.contains(ASSET_PREFIX) {
            continue;
        }
        if !href.ends_with(".zip") {
            continue;
        }

        let Some(name) = href.rsplit('/').next().map(|s| s.to_string()) else {
            continue;
        };
        if !name.starts_with(ASSET_PREFIX) || !name.ends_with(".zip") {
            continue;
        }
        if !seen_names.insert(name.clone()) {
            continue;
        }

        let url = if href.starts_with("http://") || href.starts_with("https://") {
            href
        } else {
            format!("https://github.com{href}")
        };

        assets.push(GithubAsset {
            name,
            browser_download_url: url,
        });
    }

    assets
}

fn ensure_fallback_zip_assets(tag_name: &str, assets: &mut Vec<GithubAsset>) {
    if assets.iter().any(|a| a.name.ends_with(".zip")) {
        return;
    }

    let versions = [normalize_version(tag_name), tag_name.to_string()];
    let mut seen_names: HashSet<String> = HashSet::new();

    for version in versions {
        if version.is_empty() {
            continue;
        }
        let asset_name = format!("{ASSET_PREFIX}{version}.zip");
        if !seen_names.insert(asset_name.clone()) {
            continue;
        }
        let asset_url = format!(
            "https://github.com/Flowseal/zapret-discord-youtube/releases/download/{}/{}",
            tag_name, asset_name
        );
        assets.push(GithubAsset {
            name: asset_name,
            browser_download_url: asset_url,
        });
    }
}

async fn fetch_latest_release_via_html() -> Result<GithubRelease, String> {
    let latest_url = "https://github.com/Flowseal/zapret-discord-youtube/releases/latest";
    let response = github_client()?
        .get(latest_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("GitHub releases page error: {}", response.status()));
    }

    let resolved_url = response.url().to_string();
    let tag_name = extract_tag_from_release_url(&resolved_url)
        .ok_or_else(|| format!("Failed to parse release tag from URL: {resolved_url}"))?;
    let html = response.text().await.map_err(|e| e.to_string())?;
    let mut assets = parse_assets_from_release_html(&html);
    ensure_fallback_zip_assets(&tag_name, &mut assets);

    Ok(GithubRelease {
        html_url: Some(resolved_url),
        tag_name,
        assets,
    })
}

fn extract_zip_to_dir(zip_bytes: &[u8], destination: &Path) -> Result<(), String> {
    let cursor = Cursor::new(zip_bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    fs::create_dir_all(destination).map_err(|e| e.to_string())?;

    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(enclosed) = file.enclosed_name() else {
            continue;
        };

        let out_path = destination.join(enclosed);
        if file.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out_file = File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut out_file).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn trim_ascii_whitespace_bytes(line: &[u8]) -> &[u8] {
    let mut start = 0usize;
    let mut end = line.len();

    while start < end && line[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && line[end - 1].is_ascii_whitespace() {
        end -= 1;
    }

    &line[start..end]
}

fn should_remove_check_updates_line(line: &[u8]) -> bool {
    let without_cr = line.strip_suffix(b"\r").unwrap_or(line);
    let trimmed = trim_ascii_whitespace_bytes(without_cr);
    trimmed.eq_ignore_ascii_case(b"call service.bat check_updates")
}

fn strip_check_updates_call_from_strategy(path: &Path) -> Result<(), String> {
    let content = fs::read(path).map_err(|e| e.to_string())?;
    let mut output = Vec::with_capacity(content.len());
    let mut changed = false;
    let mut index = 0usize;

    while index < content.len() {
        let line_start = index;
        while index < content.len() && content[index] != b'\n' {
            index += 1;
        }

        let has_newline = index < content.len() && content[index] == b'\n';
        let line_end = index;
        let line = &content[line_start..line_end];

        if should_remove_check_updates_line(line) {
            changed = true;
        } else {
            output.extend_from_slice(line);
            if has_newline {
                output.push(b'\n');
            }
        }

        if has_newline {
            index += 1;
        }
    }

    if changed {
        fs::write(path, output).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn patch_extracted_strategy_files(version_dir: &Path) -> Result<(), String> {
    let mut stack = vec![version_dir.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();

            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }

            let Some(name) = path.file_name().map(|v| v.to_string_lossy().to_string()) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            if lower.starts_with("general") && lower.ends_with(".bat") {
                strip_check_updates_call_from_strategy(&path)?;
            }
        }
    }

    Ok(())
}

fn ensure_strategy_selected(config: &mut AppConfig, strategies: &[String]) {
    if strategies.is_empty() {
        config.selected_strategy = None;
        return;
    }

    match &config.selected_strategy {
        Some(current) if strategies.iter().any(|s| s == current) => {}
        _ => config.selected_strategy = strategies.first().cloned(),
    }
}

fn hide_winws_windows() {
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let winws_pids = collect_winws_related_pids(&sys);

    fn get_window_text(hwnd: HWND) -> String {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return String::new();
        }

        let mut buffer = vec![0u16; (len + 1) as usize];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        if copied <= 0 {
            return String::new();
        }

        String::from_utf16_lossy(&buffer[..copied as usize])
    }

    fn get_window_class(hwnd: HWND) -> String {
        let mut buffer = vec![0u16; 256];
        let copied = unsafe { GetClassNameW(hwnd, &mut buffer) };
        if copied <= 0 {
            return String::new();
        }

        String::from_utf16_lossy(&buffer[..copied as usize])
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let set_ptr = lparam.0 as *const HashSet<u32>;
        if set_ptr.is_null() {
            return BOOL(1);
        }

        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32)); }

        let pids = unsafe { &*set_ptr };
        let title = get_window_text(hwnd).to_ascii_lowercase();
        let class_name = get_window_class(hwnd).to_ascii_lowercase();
        let is_console = class_name == "consolewindowclass";
        let has_winws_marker = title.contains("winws");
        let has_zapret_title = title.starts_with("zapret:") || title.contains("zapret: general");
        let should_hide = pids.contains(&pid)
            || has_winws_marker
            || has_zapret_title
            || (is_console && title.contains("general"));

        if should_hide {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
        BOOL(1)
    }

    unsafe {
        let ptr = &winws_pids as *const HashSet<u32>;
        let _ = EnumWindows(Some(enum_windows_proc), LPARAM(ptr as isize));
    }
}

fn start_strategy_impl() -> Result<(), String> {
    let config = load_config()?;
    let version_dir = active_version_dir(&config)?;
    sync_user_lists_to_active_version(&config)?;
    let strategy = config
        .selected_strategy
        .ok_or_else(|| "No strategy selected".to_string())?;

    let strategy_path = version_dir.join(&strategy);
    if !strategy_path.exists() {
        return Err(format!("Strategy file not found: {strategy}"));
    }

    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", &strategy])
            .current_dir(version_dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    thread::spawn(|| {
        thread::sleep(Duration::from_millis(500));
        for _ in 0..180 {
            hide_winws_windows();
            thread::sleep(Duration::from_millis(250));
        }
    });

    Ok(())
}

fn stop_strategy_impl() -> Result<(), String> {
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut pids: Vec<u32> = collect_winws_related_pids(&sys).into_iter().collect();
    pids.sort_unstable();

    if pids.is_empty() {
        return Ok(());
    }

    let mut denied_pids = Vec::new();
    for pid in &pids {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            denied_pids.push(*pid);
        }
    }

    thread::sleep(Duration::from_millis(450));

    let mut after = System::new_all();
    after.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let still_running = collect_winws_related_pids(&after);
    if !still_running.is_empty() {
        let mut remaining: Vec<u32> = still_running.into_iter().collect();
        remaining.sort_unstable();

        if !denied_pids.is_empty() {
            return Err(format!(
                "Не удалось остановить обход. Недостаточно прав для PID: {}. Запустите ZPRT App от имени администратора.",
                denied_pids
                    .iter()
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }

        return Err(format!(
            "Не удалось полностью остановить обход. Оставшиеся PID: {}",
            remaining
                .iter()
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(())
}

async fn build_ui_state() -> Result<UiState, String> {
    let installed_versions = list_installed_versions()?;
    let (config, strategies) = mutate_config(|config| {
        if config.active_version.is_none() && !installed_versions.is_empty() {
            config.active_version = installed_versions.first().cloned();
        }

        if let Some(active) = &config.active_version {
            if !installed_versions.iter().any(|v| v == active) {
                config.active_version = installed_versions.first().cloned();
                config.selected_strategy = None;
            }
        }

        let strategies = if let Some(active) = &config.active_version {
            list_strategies_for_version(active)?
        } else {
            Vec::new()
        };

        ensure_strategy_selected(config, &strategies);
        Ok((config.clone(), strategies))
    })?;

    let (list_general_user, list_exclude_user, ipset_exclude_user) = read_user_list_files()?;

    let latest = fetch_latest_release().await.ok();
    let latest_version = latest
        .as_ref()
        .map(|r| normalize_version(&r.tag_name));
    let latest_release_url = latest.as_ref().and_then(|r| r.html_url.clone());

    let newest_installed = installed_versions.first().cloned();
    let update_available = match (&newest_installed, &latest_version) {
        (Some(installed), Some(latest)) => normalize_version(installed) != normalize_version(latest),
        (None, Some(_)) => true,
        _ => false,
    };
    let update_notification_needed = if update_available && config.notify_update_available {
        match (latest_version.as_deref(), config.last_update_notification.as_deref()) {
            (Some(latest), Some(last)) => is_version_greater_than(latest, last),
            (Some(_), None) => true,
            _ => false,
        }
    } else {
        false
    };

    Ok(UiState {
        installed_versions,
        active_version: config.active_version,
        latest_version,
        latest_release_url,
        update_available,
        update_notification_needed,
        strategies,
        selected_strategy: config.selected_strategy,
        is_running: is_winws_running(),
        autostart_enabled: is_autostart_enabled(),
        notify_update_available: config.notify_update_available,
        list_general_user,
        list_exclude_user,
        ipset_exclude_user,
    })
}

#[tauri::command]
async fn load_app_state() -> Result<UiState, String> {
    build_ui_state().await
}

#[tauri::command]
async fn refresh_release_info() -> Result<UiState, String> {
    build_ui_state().await
}

#[tauri::command]
async fn install_latest(app: AppHandle) -> Result<(), String> {
    let was_running = is_winws_running();
    let previous_strategy = read_config(|config| Ok(config.selected_strategy.clone()))?;

    let release = fetch_latest_release().await?;
    let normalized_version = normalize_version(&release.tag_name);
    let version_dir = zapret_root()?.join(&normalized_version);

    if !version_dir.exists() {
        let asset = pick_zip_asset(&release)?;
        let bytes = github_client()?
            .get(&asset.browser_download_url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .bytes()
            .await
            .map_err(|e| e.to_string())?;

        extract_zip_to_dir(&bytes, &version_dir)?;
        patch_extracted_strategy_files(&version_dir)?;
    }

    if was_running {
        stop_strategy_impl()?;
    }

    let selected_strategy = mutate_config(|config| {
        config.active_version = Some(normalized_version.clone());
        let strategies = list_strategies_for_version(&normalized_version)?;
        config.selected_strategy = if let Some(prev) = previous_strategy {
            if strategies.iter().any(|s| s == &prev) {
                Some(prev)
            } else {
                strategies.first().cloned()
            }
        } else {
            strategies.first().cloned()
        };
        Ok(config.selected_strategy.clone())
    })?;

    if was_running && selected_strategy.is_some() {
        start_strategy_impl()?;
        set_tray_icon_for_state(&app, true);
        apply_tray_menu_state(&app, true);
    } else {
        let running = is_winws_running();
        set_tray_icon_for_state(&app, running);
        apply_tray_menu_state(&app, running);
    }

    refresh_tray_menu(&app);
    emit_bypass_state_changed(&app);
    Ok(())
}

#[tauri::command]
async fn switch_active_version(app: AppHandle, version: String) -> Result<(), String> {
    let installed = list_installed_versions()?;
    if !installed.iter().any(|v| v == &version) {
        return Err(format!("Version is not installed: {version}"));
    }

    mutate_config(|config| {
        config.active_version = Some(version.clone());
        let strategies = list_strategies_for_version(&version)?;
        ensure_strategy_selected(config, &strategies);
        Ok(())
    })?;
    refresh_tray_menu(&app);
    Ok(())
}

fn select_strategy_impl(app: &AppHandle, strategy: String) -> Result<(), String> {
    let was_running = is_winws_running();
    mutate_config(|config| {
        let version = config
            .active_version
            .clone()
            .ok_or_else(|| "Select a version first".to_string())?;

        let strategies = list_strategies_for_version(&version)?;
        if !strategies.iter().any(|s| s == &strategy) {
            return Err(format!("Unknown strategy: {strategy}"));
        }

        config.selected_strategy = Some(strategy.clone());
        Ok(())
    })?;
    refresh_tray_menu(app);

    if was_running {
        stop_strategy_impl()?;
        if let Err(err) = start_strategy_impl() {
            set_tray_icon_for_state(app, false);
            emit_bypass_state_changed(app);
            return Err(format!(
                "Старая стратегия остановлена, но новую запустить не удалось: {err}"
            ));
        }
        set_tray_icon_for_state(app, true);
        emit_bypass_state_changed(app);
    } else {
        set_tray_icon_for_state(app, false);
        emit_bypass_state_changed(app);
    }

    Ok(())
}

#[tauri::command]
async fn select_strategy(app: AppHandle, strategy: String) -> Result<(), String> {
    select_strategy_impl(&app, strategy)
}

#[tauri::command]
async fn start_bypass(app: AppHandle) -> Result<(), String> {
    start_strategy_impl()?;
    set_tray_icon_for_state(&app, true);
    apply_tray_menu_state(&app, true);
    emit_bypass_state_changed(&app);
    Ok(())
}

#[tauri::command]
async fn stop_bypass(app: AppHandle) -> Result<(), String> {
    stop_strategy_impl()?;
    set_tray_icon_for_state(&app, false);
    apply_tray_menu_state(&app, false);
    emit_bypass_state_changed(&app);
    Ok(())
}

#[tauri::command]
async fn set_autostart(enabled: bool) -> Result<(), String> {
    set_autostart_impl(enabled)
}

#[tauri::command]
async fn open_service_bat() -> Result<(), String> {
    let config = load_config()?;
    let version_dir = active_version_dir(&config)?;
    let service_path = version_dir.join("service.bat");
    if !service_path.exists() {
        return Err("Файл service.bat не найден в выбранной версии".to_string());
    }

    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "start", "", "service.bat"])
            .current_dir(version_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn open_active_version_folder() -> Result<(), String> {
    let config = load_config()?;
    let version_dir = active_version_dir(&config)?;

    #[cfg(windows)]
    {
        Command::new("explorer")
            .arg(&version_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Unsupported URL".to_string());
    }
    open_in_browser(&url)
}

#[tauri::command]
async fn open_release_info_for_version(version: String) -> Result<(), String> {
    let normalized = normalize_version(&version);
    let tags = [normalized.clone(), format!("v{normalized}")];

    for tag in tags {
        if let Ok(release) = fetch_release_by_tag(&tag).await {
            let url = release.html_url.unwrap_or_else(|| {
                format!(
                    "https://github.com/Flowseal/zapret-discord-youtube/releases/tag/{}",
                    release.tag_name
                )
            });
            return open_in_browser(&url);
        }
    }

    Err(format!("Release info not found for version: {version}"))
}

#[tauri::command]
async fn set_update_notifications_enabled(enabled: bool) -> Result<(), String> {
    mutate_config(|config| {
        config.notify_update_available = enabled;
        Ok(())
    })
}

#[tauri::command]
async fn hide_update_toast(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(UPDATE_TOAST_WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_main_versions_from_toast(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(UPDATE_TOAST_WINDOW_LABEL) {
        if let Err(err) = window.hide() {
            debug_log_error("open_main_versions_from_toast.window.hide", &err.to_string());
        }
    }

    show_main_window(&app);
    app.emit(OPEN_VERSIONS_TAB_EVENT, ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn save_user_list_file(list_kind: String, content: String) -> Result<(), String> {
    let (general_path, exclude_path, ipset_exclude_path) = user_list_paths()?;
    let target = match list_kind.as_str() {
        "general" => general_path,
        "excludeDomains" => exclude_path,
        "excludeIps" => ipset_exclude_path,
        _ => return Err(format!("Unknown user list kind: {list_kind}")),
    };

    fs::write(target, content).map_err(|e| e.to_string())?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.show() {
            debug_log_error("show_main_window.window.show", &err.to_string());
        }
        if let Err(err) = window.unminimize() {
            debug_log_error("show_main_window.window.unminimize", &err.to_string());
        }
        if let Err(err) = window.set_focus() {
            debug_log_error("show_main_window.window.set_focus", &err.to_string());
        }
    }
    emit_bypass_state_changed(app);
}

fn build_tray_circle_icon(r: u8, g: u8, b: u8) -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let center = (SIZE as f32 - 1.0) / 2.0;
    let radius = 11.5f32;

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let idx = ((y * SIZE + x) * 4) as usize;

            if dist <= radius + 1.0 {
                rgba[idx] = r;
                rgba[idx + 1] = g;
                rgba[idx + 2] = b;
                rgba[idx + 3] = if dist <= radius {
                    255
                } else {
                    ((1.0 - (dist - radius)).clamp(0.0, 1.0) * 255.0) as u8
                };
            }
        }
    }

    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

fn set_tray_icon_for_state(app: &AppHandle, is_running: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let icon = if is_running {
            build_tray_circle_icon(0x03, 0xFC, 0x66)
        } else {
            build_tray_circle_icon(0x03, 0x67, 0xFC)
        };
        let _ = tray.set_icon(Some(icon));
    }
}

fn emit_bypass_state_changed(app: &AppHandle) {
    let _ = app.emit("bypass-state-changed", ());
}

fn is_version_greater_than(left: &str, right: &str) -> bool {
    match (parse_version_for_sort(left), parse_version_for_sort(right)) {
        (Some(l), Some(r)) => l > r,
        _ => normalize_version(left) != normalize_version(right),
    }
}

fn ensure_update_toast_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(UPDATE_TOAST_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        app,
        UPDATE_TOAST_WINDOW_LABEL,
        WebviewUrl::App("index.html#update-toast".into()),
    )
    .title("ZPRT Update Toast")
    .inner_size(UPDATE_TOAST_WIDTH, UPDATE_TOAST_HEIGHT)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false);

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

fn position_update_toast_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(UPDATE_TOAST_WINDOW_LABEL) else {
        return Ok(());
    };

    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Primary monitor not found".to_string())?;
    let work_area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width_px = (UPDATE_TOAST_WIDTH * scale).round() as i32;
    let height_px = (UPDATE_TOAST_HEIGHT * scale).round() as i32;
    let x = work_area.position.x + work_area.size.width as i32 - width_px - UPDATE_TOAST_MARGIN;
    let y = work_area.position.y + work_area.size.height as i32 - height_px - UPDATE_TOAST_MARGIN;

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

fn show_custom_update_notification(app: &AppHandle, latest_version: &str) -> Result<(), String> {
    ensure_update_toast_window(app)?;
    position_update_toast_window(app)?;

    let window = app
        .get_webview_window(UPDATE_TOAST_WINDOW_LABEL)
        .ok_or_else(|| "Toast window is not available".to_string())?;

    let payload = format!("Доступна новая версия zapret: {latest_version}");
    if let Err(err) = window.emit(UPDATE_TOAST_EVENT, payload) {
        debug_log_error("show_custom_update_notification.window.emit", &err.to_string());
    }
    if let Err(err) = window.show() {
        debug_log_error("show_custom_update_notification.window.show", &err.to_string());
    }

    let hide_seq = if let Some(flags) = app.try_state::<AppFlags>() {
        if let Ok(mut seq) = flags.toast_hide_seq.lock() {
            *seq += 1;
            *seq
        } else {
            0
        }
    } else {
        0
    };

    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(UPDATE_TOAST_HIDE_SECS));

        let should_hide = app_handle
            .try_state::<AppFlags>()
            .and_then(|flags| flags.toast_hide_seq.lock().ok().map(|seq| *seq == hide_seq))
            .unwrap_or(true);

        if should_hide {
            if let Some(win) = app_handle.get_webview_window(UPDATE_TOAST_WINDOW_LABEL) {
                if let Err(err) = win.hide() {
                    debug_log_error("show_custom_update_notification.auto_hide.window.hide", &err.to_string());
                }
            }
        }
    });

    Ok(())
}

async fn check_and_notify_new_zapret_version(app: &AppHandle) -> Result<(), String> {
    let release = fetch_latest_release().await?;
    let latest_version = normalize_version(&release.tag_name);

    let installed_versions = list_installed_versions()?;
    let newest_installed = installed_versions.first().cloned();
    let update_available = match newest_installed.as_deref() {
        Some(installed) => normalize_version(installed) != latest_version,
        None => true,
    };

    if !update_available {
        return Ok(());
    }

    let should_notify = read_config(|config| {
        if !config.notify_update_available {
            return Ok(false);
        }
        Ok(match config.last_update_notification.as_deref() {
            Some(last) => is_version_greater_than(&latest_version, last),
            None => true,
        })
    })?;

    if !should_notify {
        return Ok(());
    }

    show_custom_update_notification(app, &latest_version)?;

    mutate_config(|config| {
        config.last_update_notification = Some(latest_version.clone());
        Ok(())
    })?;

    Ok(())
}

fn start_update_check_worker(app: AppHandle) {
    thread::spawn(move || {
        loop {
            let _ = tauri::async_runtime::block_on(check_and_notify_new_zapret_version(&app));
            thread::sleep(Duration::from_secs(UPDATE_CHECK_INTERVAL_SECS));
        }
    });
}

fn build_tray_strategy_submenu(app: &AppHandle) -> Result<Submenu<tauri::Wry>, tauri::Error> {
    let config = load_config().ok();
    let active_version = config.as_ref().and_then(|c| c.active_version.clone());
    let selected_strategy = config.as_ref().and_then(|c| c.selected_strategy.clone());

    let strategies = match active_version.as_deref() {
        Some(version) => list_strategies_for_version(version).unwrap_or_default(),
        None => Vec::new(),
    };

    if let Some(version) = active_version {
        if !strategies.is_empty() {
            let mut strategy_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
            for strategy in &strategies {
                strategy_items.push(CheckMenuItem::with_id(
                    app,
                    format!("{TRAY_MENU_STRATEGY_PREFIX}{strategy}"),
                    strategy,
                    true,
                    selected_strategy.as_deref() == Some(strategy.as_str()),
                    None::<&str>,
                )?);
            }

            let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = strategy_items
                .iter()
                .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
                .collect();
            return Submenu::with_items(app, format!("Стратегия ({version})"), true, &refs);
        }

        let empty_item =
            MenuItem::with_id(app, "strategy_empty", "Нет стратегий", false, None::<&str>)?;
        let refs: [&dyn tauri::menu::IsMenuItem<tauri::Wry>; 1] = [&empty_item];
        return Submenu::with_items(app, format!("Стратегия ({version})"), true, &refs);
    }

    let empty_item = MenuItem::with_id(
        app,
        "strategy_version_missing",
        "Сначала установите и выберите версию",
        false,
        None::<&str>,
    )?;
    let refs: [&dyn tauri::menu::IsMenuItem<tauri::Wry>; 1] = [&empty_item];
    Submenu::with_items(app, "Стратегия", false, &refs)
}

fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    build_tray_menu_for_state(app, is_winws_running())
}

fn build_tray_menu_for_state(
    app: &AppHandle,
    is_running: bool,
) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let show_item = MenuItem::with_id(app, "show", "Открыть ZPRT App", true, None::<&str>)?;
    let start_item = MenuItem::with_id(app, "start", "Запустить обход", true, None::<&str>)?;
    let restart_item =
        MenuItem::with_id(app, "restart", "Перезапустить обход", true, None::<&str>)?;
    let stop_item = MenuItem::with_id(app, "stop", "Остановить обход", true, None::<&str>)?;
    let strategy_submenu = build_tray_strategy_submenu(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;

    if is_running {
        Menu::with_items(
            app,
            &[
                &show_item,
                &restart_item,
                &stop_item,
                &strategy_submenu,
                &quit_item,
            ],
        )
    } else {
        Menu::with_items(app, &[&show_item, &start_item, &strategy_submenu, &quit_item])
    }
}

fn refresh_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn apply_tray_menu_state(app: &AppHandle, is_running: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu_for_state(app, is_running) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn is_running_as_admin() -> bool {
    #[cfg(windows)]
    unsafe {
        return IsUserAnAdmin().as_bool();
    }

    #[allow(unreachable_code)]
    false
}

fn ensure_single_instance_or_exit(silent_if_running: bool) {
    #[cfg(windows)]
    unsafe {
        let name = HSTRING::from(SINGLE_INSTANCE_MUTEX);
        let _mutex = CreateMutexW(None, false, &name);
        if GetLastError() == ERROR_ALREADY_EXISTS {
            if silent_if_running {
                std::process::exit(0);
            }
            let text = HSTRING::from(
                "ZPRT App уже запущен.\nЗакройте текущий экземпляр перед повторным запуском.",
            );
            let title = HSTRING::from("Экземпляр уже запущен");
            let _ = MessageBoxW(None, &text, &title, MB_OK | MB_ICONERROR);
            std::process::exit(1);
        }
    }
}

fn setup_tray(app: &AppHandle) -> Result<(), tauri::Error> {
    let menu = build_tray_menu(app)?;

    let icon = if is_winws_running() {
        build_tray_circle_icon(0x03, 0xFC, 0x66)
    } else {
        build_tray_circle_icon(0x03, 0x67, 0xFC)
    };

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();

            if let Some(strategy) = id.strip_prefix(TRAY_MENU_STRATEGY_PREFIX) {
                let _ = select_strategy_impl(app, strategy.to_string());
                refresh_tray_menu(app);
                return;
            }

            match id {
                "show" => show_main_window(app),
                "start" => {
                    if start_strategy_impl().is_ok() {
                        set_tray_icon_for_state(app, true);
                        apply_tray_menu_state(app, true);
                    } else {
                        set_tray_icon_for_state(app, is_winws_running());
                        refresh_tray_menu(app);
                    }
                    emit_bypass_state_changed(app);
                }
                "restart" => {
                    let restarted = stop_strategy_impl().is_ok() && start_strategy_impl().is_ok();
                    if restarted {
                        set_tray_icon_for_state(app, true);
                        apply_tray_menu_state(app, true);
                    } else {
                        set_tray_icon_for_state(app, is_winws_running());
                        refresh_tray_menu(app);
                    }
                    emit_bypass_state_changed(app);
                }
                "stop" => {
                    if stop_strategy_impl().is_ok() {
                        set_tray_icon_for_state(app, false);
                        apply_tray_menu_state(app, false);
                    } else {
                        set_tray_icon_for_state(app, is_winws_running());
                        refresh_tray_menu(app);
                    }
                    emit_bypass_state_changed(app);
                }
                "quit" => {
                    if let Some(flags) = app.try_state::<AppFlags>() {
                        if let Ok(mut is_quitting) = flags.is_quitting.lock() {
                            *is_quitting = true;
                        }
                    }
                    app.exit(0);
                }
                _ => {}
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
        })
        .build(app)?;

    Ok(())
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let is_autostart_launch = args.iter().any(|arg| arg == "--autostart");
    refresh_debug_mode_from_config();

    if !is_running_as_admin() {
        let text = HSTRING::from(
            "Для работы ZPRT App требуются права администратора.\nПерезапустите приложение от имени администратора.",
        );
        let title = HSTRING::from("Недостаточно прав");
        unsafe {
            let _ = MessageBoxW(None, &text, &title, MB_OK | MB_ICONERROR);
        }
        std::process::exit(1);
    }

    ensure_single_instance_or_exit(is_autostart_launch);

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppFlags::default())
        .setup(move |app| {
            setup_tray(app.handle())?;
            set_tray_icon_for_state(app.handle(), is_winws_running());
            let _ = user_list_paths();
            if let Err(err) = ensure_update_toast_window(app.handle()) {
                debug_log_error("run.setup.ensure_update_toast_window", &err);
            }
            start_update_check_worker(app.handle().clone());

            if is_autostart_launch {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(err) = window.hide() {
                        debug_log_error("run.setup.autostart.main_window.hide", &err.to_string());
                    }
                }
                if start_strategy_impl().is_ok() {
                    set_tray_icon_for_state(app.handle(), true);
                    apply_tray_menu_state(app.handle(), true);
                } else {
                    let running = is_winws_running();
                    set_tray_icon_for_state(app.handle(), running);
                    apply_tray_menu_state(app.handle(), running);
                }
                emit_bypass_state_changed(app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == UPDATE_TOAST_WINDOW_LABEL {
                    api.prevent_close();
                    if let Err(err) = window.hide() {
                        debug_log_error("run.on_window_event.toast.window.hide", &err.to_string());
                    }
                    return;
                }

                let should_quit = window
                    .app_handle()
                    .try_state::<AppFlags>()
                    .and_then(|f| f.is_quitting.lock().ok().map(|g| *g))
                    .unwrap_or(false);

                if !should_quit {
                    api.prevent_close();
                    if let Err(err) = window.hide() {
                        debug_log_error("run.on_window_event.main.window.hide", &err.to_string());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_app_state,
            refresh_release_info,
            install_latest,
            switch_active_version,
            select_strategy,
            start_bypass,
            stop_bypass,
            set_autostart,
            open_service_bat,
            open_active_version_folder,
            open_external_url,
            open_release_info_for_version,
            set_update_notifications_enabled,
            hide_update_toast,
            open_main_versions_from_toast,
            save_user_list_file,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            debug_log_error("run.tauri_builder.run", &err.to_string());
            panic!("error while running tauri application: {err}");
        });
}


