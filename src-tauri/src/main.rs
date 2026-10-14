#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(windows)]
mod windows_process {
    use super::*;
    use std::os::windows::{io::{AsRawHandle, FromRawHandle, OwnedHandle}, process::CommandExt};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD},
            JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
            Threading::{OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
        },
    };

    fn last_error(context: &str) -> String {
        format!("{context}: {}", std::io::Error::last_os_error())
    }

    pub fn spawn(command: &mut Command) -> Result<OwnedProcess, String> {
        // Create a private, non-inheritable job. All descendants inherit membership,
        // but none inherits the handle that keeps the job alive.
        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() { return Err(last_error("Cannot create backend process job")); }
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe { SetInformationJobObject(job.as_raw_handle(), JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) } == 0 {
            return Err(last_error("Cannot configure backend process job"));
        }
        // Suspend before assignment: even PyInstaller's bootloader cannot create an
        // unowned child in the gap between spawn and AssignProcessToJobObject.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let child = command.spawn().map_err(|e| format!("Cannot start PaperLine backend: {e}"))?;
        let mut process = OwnedProcess { child, stopped: false, job: Some(job) };
        let assigned = unsafe { AssignProcessToJobObject(process.job.as_ref().unwrap().as_raw_handle(), process.child.as_raw_handle()) };
        if assigned == 0 {
            let error = last_error("Cannot assign backend to its process job");
            // An unassigned process is still suspended and has no descendants.
            let _ = process.child.kill();
            let _ = process.child.wait();
            process.stopped = true;
            return Err(error);
        }
        if let Err(error) = resume_initial_thread(process.child.id()) {
            process.force_stop();
            return Err(error);
        }
        Ok(process)
    }

    fn resume_initial_thread(pid: u32) -> Result<(), String> {
        // std::process::Child exposes the process handle, not its initial thread.
        // While suspended there is exactly one thread; locate only our child's PID.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if raw == INVALID_HANDLE_VALUE { return Err(last_error("Cannot inspect suspended backend thread")); }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                let raw_thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if raw_thread.is_null() { return Err(last_error("Cannot open backend startup thread")); }
                let thread = unsafe { OwnedHandle::from_raw_handle(raw_thread) };
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(last_error("Cannot resume backend startup thread"));
                }
                return Ok(());
            }
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        Err("Cannot find the suspended backend startup thread".into())
    }
}

impl Drop for OwnedProcess { fn drop(&mut self) { self.force_stop(); } }

fn backend_binary_name(target: Option<&str>) -> String {
    let stem = target.map(|target| format!("paperline-backend-{target}"))
        .unwrap_or_else(|| "paperline-backend".into());
    if cfg!(windows) { format!("{stem}.exe") } else { stem }
}

fn spawn_owned(command: &mut Command) -> Result<OwnedProcess, String> {
    #[cfg(windows)]
    { windows_process::spawn(command) }
    #[cfg(not(windows))]
    {
        #[cfg(unix)]
        command.process_group(0);
        let child = command.spawn().map_err(|e| format!("Cannot start PaperLine backend: {e}"))?;
        Ok(OwnedProcess { child, stopped: false })
    }
}

struct OwnedProcess {
    child: Child,
    stopped: bool,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}
impl OwnedProcess {
    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let result = self.child.try_wait()?;
        if result.is_some() {
            self.stopped = true;
            #[cfg(windows)]
            self.job.take(); // Close the job even after a clean exit; no orphan descendants.
        }
        Ok(result)
    }
    fn force_stop(&mut self) {
        if self.stopped { return; }
        self.stopped = true;
        #[cfg(unix)]
        {
            // The backend is the leader of a new group created by process_group(0).
            // Keep its PID unreaped until both signals are sent, preventing PID reuse.
            let group = -(self.child.id() as libc::pid_t);
            unsafe { libc::kill(group, libc::SIGTERM); }
            std::thread::sleep(Duration::from_millis(500));
            unsafe { libc::kill(group, libc::SIGKILL); }
        }
        #[cfg(windows)]
        self.job.take(); // KILL_ON_JOB_CLOSE terminates only this owned process tree.
        #[cfg(not(any(unix, windows)))]
        { let _ = self.child.kill(); }
        let _ = self.child.wait();
    }
}


struct Backend {
    child: Arc<Mutex<OwnedProcess>>,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Result<Value, String>>,
    next_id: u64,
}

impl Backend {
    fn start(data_dir: &std::path::Path) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let packaged = executable.parent().ok_or("Missing executable directory")?.join(backend_binary_name(None));
        let binary = if packaged.is_file() { packaged } else {
            #[cfg(debug_assertions)]
            { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(backend_binary_name(Some(env!("PAPERLINE_TARGET")))) }
            #[cfg(not(debug_assertions))]
            { return Err("Bundled PaperLine backend is missing".into()); }
        };
        let mut command = Command::new(binary);
        command.arg("--data-dir").arg(data_dir)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        command.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
        let mut process = spawn_owned(&mut command)?;
        let input = process.child.stdin.take();
        let stdout = process.child.stdout.take().ok_or("Backend stdout unavailable")?;
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let parsed = line.map_err(|e| e.to_string()).and_then(|s| serde_json::from_str(&s).map_err(|e| format!("Invalid backend response: {e}")));
                if tx.send(parsed).is_err() { break; }
            }
        });
        let backend = Self { child: Arc::new(Mutex::new(process)), input, output, next_id: 1 };
        let ready = backend.output.recv_timeout(Duration::from_secs(30))
            .map_err(|e| format!("Backend startup failed: {e}"))??;
        if ready.get("ready") != Some(&Value::Bool(true)) || ready.get("protocol") != Some(&json!(1)) {
            return Err("Unsupported backend protocol".into());
        }
        Ok(backend)
    }

    fn request(&mut self, method: &str, path: &str, body: Value) -> Result<ApiResponse, String> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"id": id, "method": method, "path": path, "body": body});
        let input = self.input.as_mut().ok_or("PaperLine backend has stopped")?;
        serde_json::to_writer(&mut *input, &request).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())?;
        // A timed-out response must never be matched to a later request.
        let reply = match self.output.recv_timeout(Duration::from_secs(120)) {
            Ok(reply) => reply?,
            Err(e) => {
                self.input.take();
                self.child.lock().unwrap().force_stop();
                return Err(format!("PaperLine backend did not respond: {e}. Restart PaperLine."));
            }
        };
        if reply.get("id") != Some(&json!(id)) {
            self.input.take();
            self.child.lock().unwrap().force_stop();
            return Err("Backend response ID mismatch. Restart PaperLine.".into());
        }
        let status = reply.get("status").and_then(Value::as_u64).ok_or("Backend response has no status")?;
        Ok(ApiResponse { status: status as u16, data: reply.get("data").cloned().unwrap_or(Value::Null) })
    }

    fn shutdown(&mut self) -> bool {
        // EOF is the protocol's graceful shutdown signal; it also stops sync workers.
        self.input.take();
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            match self.child.lock().unwrap().try_wait() {
                Ok(Some(status)) => return status.success(),
                _ if Instant::now() >= until => break,
                _ => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        self.child.lock().unwrap().force_stop();
        false
    }
}
impl Drop for Backend { fn drop(&mut self) { self.shutdown(); } }

type SharedBackend = Arc<Mutex<Backend>>;
struct BackendProcess(Arc<Mutex<OwnedProcess>>);
#[derive(Serialize)]
struct ApiResponse { status: u16, data: Value }

fn api_allowed(method: &str, path: &str) -> bool {
    let route = path.split('?').next().unwrap_or("");
    if path.contains('#') || path.contains('\\') || path.contains('\n') || path.contains('\r') { return false; }
    match method {
        "GET" => matches!(route, "/api/state" | "/api/backup" | "/api/zotero/search" | "/api/zotero/annotations" | "/api/zotero/sync" | "/api/webdav" | "/api/webdav/cloud" | "/api/desktop/info"),
        "POST" => matches!(route, "/api/action" | "/api/restore" | "/api/zotero/sync" | "/api/export" | "/api/webdav/config" | "/api/webdav/test" | "/api/webdav/sync" | "/api/webdav/restore"),
        _ => false,
    }
}

#[tauri::command]
async fn api_request(backend: tauri::State<'_, SharedBackend>, method: String, path: String, body: Option<Value>) -> Result<ApiResponse, String> {
    if !api_allowed(&method, &path) { return Err("Unsupported PaperLine API request".into()); }
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        backend.lock().map_err(|_| "Backend lock failed".to_string())?.request(&method, &path, body.filter(Value::is_object).unwrap_or_else(|| json!({})))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn choose_directory() -> Option<String> {
    rfd::AsyncFileDialog::new().set_title("PaperLine — Obsidian vault").pick_folder().await.map(|file| file.path().to_string_lossy().into_owned())
}

#[tauri::command]
async fn save_backup(contents: String) -> Result<Option<String>, String> {
    // Backup exports are JSON, never executable content.
    serde_json::from_str::<Value>(&contents).map_err(|_| "Backup is not valid JSON".to_string())?;
    let Some(file) = rfd::AsyncFileDialog::new().set_title("PaperLine — Save backup")
        .set_file_name("PaperLine-backup.json").add_filter("JSON backup", &["json"])
        .save_file().await else { return Ok(None); };
    let path = file.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, contents).map_err(|e| format!("Cannot save backup: {e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(|e| e.to_string())?
}

fn internal_allowed(url: &url::Url) -> bool {
    let (scheme, host) = if cfg!(windows) { ("http", "tauri.localhost") } else { ("tauri", "localhost") };
    url.scheme() == scheme && url.host_str() == Some(host) && url.port().is_none()
        && url.username().is_empty() && url.password().is_none()
}

fn external_allowed(raw: &str) -> bool {
    if raw.chars().any(char::is_control) { return false; }
    let Ok(url) = url::Url::parse(raw) else { return false; };
    match url.scheme() {
        "http" | "https" => url.host_str().is_some() && url.username().is_empty() && url.password().is_none(),
        "zotero" => matches!(url.host_str(), Some("select" | "open-pdf")),
        _ => false,
    }
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    if !external_allowed(&url) { return Err("Unsupported external link".into()); }
    tauri::async_runtime::spawn_blocking(move || open::that_detached(url).map_err(|e| e.to_string()))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn confirm_action(message: String) -> bool {
    rfd::AsyncMessageDialog::new().set_title("PaperLine").set_description(message)
        .set_buttons(rfd::MessageButtons::YesNo).show().await == rfd::MessageDialogResult::Yes
}

fn startup_error(message: &str) -> ! {
    eprintln!("PaperLine startup failed: {message}");
    rfd::MessageDialog::new().set_title("PaperLine — Cannot start")
        .set_description(format!("PaperLine could not start its local workspace.\n\n{message}\n\nReinstall the complete application or contact support."))
        .set_level(rfd::MessageLevel::Error).set_buttons(rfd::MessageButtons::Ok).show();
    std::process::exit(1);
}

fn setup_app(app: &mut tauri::App, smoke_dir: Option<&std::path::Path>) -> Result<(), Box<dyn std::error::Error>> {
            let data_dir = match smoke_dir {
                Some(directory) => directory.to_path_buf(),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            let mut backend = Backend::start(&data_dir).map_err(std::io::Error::other)?;
            if smoke_dir.is_some() {
                let reply = backend.request("GET", "/api/state", json!({})).map_err(std::io::Error::other)?;
                if reply.status != 200 || reply.data.get("version") != Some(&json!(1)) {
                    return Err(std::io::Error::other("Smoke test backend state validation failed").into());
                }
            }
            app.manage(BackendProcess(backend.child.clone()));
            app.manage(Arc::new(Mutex::new(backend)));
            let app_handle = app.handle().clone();
            let mut window_builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("PaperLine").inner_size(1380.0, 900.0).min_inner_size(760.0, 560.0)
                .on_navigation(internal_allowed)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            if let Some(directory) = smoke_dir {
                window_builder = window_builder.incognito(true).data_directory(directory.join("webview"));
            }
            let window = window_builder.build()?;
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) { app_handle.exit(0); }
            });
            if smoke_dir.is_some() {
                eprintln!("PaperLine smoke: backend protocol verified; window created.");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(5));
                    handle.exit(0);
                });
            }
            Ok(())
}

fn smoke_directory(args: Vec<std::ffi::OsString>) -> Result<Option<std::path::PathBuf>, String> {
    if args.is_empty() { return Ok(None); }
    if args.len() != 2 || args[0] != "--smoke-test" {
        return Err("Expected no arguments or --smoke-test <absolute empty directory>".into());
    }
    let directory = std::path::PathBuf::from(&args[1]);
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("Smoke-test directory must be an existing absolute directory".into());
    }
    if std::fs::read_dir(&directory).map_err(|e| e.to_string())?.next().is_some() {
        return Err("Smoke-test directory must be empty; existing app data cannot be used".into());
    }
    Ok(Some(directory))
}

fn main() {
    let smoke_dir = smoke_directory(std::env::args_os().skip(1).collect()).unwrap_or_else(|error| {
        eprintln!("PaperLine startup failed: {error}");
        std::process::exit(1);
    });
    let smoke = smoke_dir.is_some();
    let mut builder = tauri::Builder::default();
    // An explicit fixture run must not be redirected to a live production instance.
    if !smoke {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .invoke_handler(tauri::generate_handler![api_request, choose_directory, save_backup, open_external, confirm_action])
        .setup(move |app| {
            if let Err(error) = setup_app(app, smoke_dir.as_deref()) {
                // A window creation failure occurs after the backend was registered.
                // Close it before the error dialog/process exit, including on Unix.
                if let Some(backend) = app.try_state::<SharedBackend>() {
                    if let Ok(mut backend) = backend.lock() { backend.shutdown(); }
                }
                if smoke { eprintln!("PaperLine smoke failed: {error}"); std::process::exit(1); }
                startup_error(&error.to_string());
            }
            Ok(())
        })
        .build(tauri::generate_context!()).unwrap_or_else(|error| {
            if smoke { eprintln!("PaperLine smoke failed: {error}"); std::process::exit(1); }
            startup_error(&error.to_string())
        });
    app.run(move |app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(backend) = app.try_state::<SharedBackend>() {
                let until = Instant::now() + Duration::from_secs(15);
                loop {
                    if let Ok(mut backend) = backend.try_lock() {
                        let graceful = backend.shutdown();
                        if smoke && !graceful {
                            eprintln!("PaperLine smoke failed: backend required forced shutdown");
                            std::process::exit(1);
                        }
                        if smoke { eprintln!("PaperLine smoke: graceful shutdown completed."); }
                        break;
                    }
                    if Instant::now() >= until {
                        // A hung API call cannot keep an invisible app alive indefinitely.
                        if let Some(process) = app.try_state::<BackendProcess>() {
                            if let Ok(mut child) = process.0.lock() { child.force_stop(); }
                        }
                        if smoke { eprintln!("PaperLine smoke failed: backend request blocked shutdown"); std::process::exit(1); }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn forced_shutdown_terminates_owned_descendants() {
        let mut command = Command::new("/bin/sh");
        // The shell reaps its terminated descendant, avoiding a zombie-only false positive.
        command.args(["-c", "trap 'wait; exit 0' TERM; sleep 60 & echo $!; wait"])
            .process_group(0).stdout(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let descendant: libc::pid_t = line.trim().parse().unwrap();
        let mut process = OwnedProcess { child, stopped: false };
        process.force_stop();
        let until = Instant::now() + Duration::from_secs(3);
        while unsafe { libc::kill(descendant, 0) } == 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(unsafe { libc::kill(descendant, 0) }, -1, "owned descendant survived forced shutdown");
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        // Repeated cleanup must not signal a reused PID or process group.
        process.force_stop();
    }
    #[test]
    fn backend_filename_matches_the_target_platform() {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        assert_eq!(backend_binary_name(None), format!("paperline-backend{suffix}"));
        assert_eq!(backend_binary_name(Some("target")), format!("paperline-backend-target{suffix}"));
    }
    #[test]
    fn smoke_arguments_cannot_select_existing_app_data() {
        assert!(smoke_directory(vec![]).unwrap().is_none());
        assert!(smoke_directory(vec!["--unknown".into()]).is_err());
        assert!(smoke_directory(vec!["--smoke-test".into(), "relative".into()]).is_err());
        let fixture = std::env::temp_dir().join(format!("paperline-smoke-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&fixture).unwrap();
        assert_eq!(smoke_directory(vec!["--smoke-test".into(), fixture.clone().into_os_string()]).unwrap(), Some(fixture.clone()));
        std::fs::write(fixture.join("state.json"), b"existing data").unwrap();
        assert!(smoke_directory(vec!["--smoke-test".into(), fixture.clone().into_os_string()]).is_err());
        std::fs::remove_dir_all(fixture).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_job_terminates_only_owned_descendants() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", "$p = Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden; Write-Output $p.Id; Start-Sleep -Seconds 60"])
            .stdout(Stdio::piped());
        let mut process = spawn_owned(&mut command).unwrap();
        let mut line = String::new();
        BufReader::new(process.child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let descendant: u32 = line.trim().parse().unwrap();
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, descendant) };
        assert!(!raw.is_null());
        let descendant_handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        // A separately owned job remains untouched by stopping the first tree.
        let mut unrelated = Command::new("powershell.exe");
        unrelated.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"]);
        let mut other = spawn_owned(&mut unrelated).unwrap();
        process.force_stop();
        assert_eq!(unsafe { WaitForSingleObject(descendant_handle.as_raw_handle(), 3000) }, WAIT_OBJECT_0);
        assert!(other.try_wait().unwrap().is_none());
        process.force_stop();
        other.force_stop();
    }
    #[test]
    fn api_scope_is_explicit() {
        assert!(api_allowed("GET", "/api/zotero/search?q=hello"));
        assert!(api_allowed("POST", "/api/restore"));
        assert!(!api_allowed("POST", "/api/desktop/shutdown"));
        assert!(!api_allowed("GET", "https://example.org/api/state"));
        assert!(!api_allowed("DELETE", "/api/state"));
    }
    #[test]
    fn navigation_stays_in_the_packaged_origin() {
        let origin = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
        assert!(internal_allowed(&url::Url::parse(origin).unwrap()));
        let other = if cfg!(windows) { "tauri://localhost/index.html" } else { "http://tauri.localhost/index.html" };
        assert!(!internal_allowed(&url::Url::parse(other).unwrap()));
        for raw in ["http://localhost:8765", "https://tauri.localhost", "tauri://localhost:9000", "tauri://example.org"] {
            assert!(!internal_allowed(&url::Url::parse(raw).unwrap()), "{raw}");
        }
    }
    #[test]
    fn external_links_cannot_launch_arbitrary_protocols() {
        for url in ["https://arxiv.org/abs/2601.12345", "http://example.org", "zotero://select/library/items/ABC", "zotero://open-pdf/library/items/ABC?page=1"] { assert!(external_allowed(url), "{url}"); }
        for url in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,test", "zotero://delete/library/items/ABC", "https://user:secret@example.org", "https://example.org\n"] { assert!(!external_allowed(url), "{url}"); }
    }
}
