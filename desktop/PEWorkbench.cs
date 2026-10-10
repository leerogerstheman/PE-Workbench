// PEWorkbench.exe - native desktop window for the PharmacoEconomics Workbench.
//
// Build: node scripts\build-desktop.js   (compiles with the built-in .NET
//        Framework C# compiler, /platform:x86 to match the Evergreen WebView2
//        runtime layout; no installers, no third-party setup beyond the
//        WebView2 runtime that Windows ships with).
//
// What this window is:
//   - a REAL native WinForms window (its own taskbar entry, title bar, tray
//     icon), not a browser tab and not a browser shell;
//   - it embeds the WebView2 control, the Microsoft component for in-app web
//     content (the same technology Teams / VS Code / Office web views use), so
//     the workbench UI renders inside our own window;
//   - it manages the local Node service as a hidden background child: starts
//     it, waits for readiness, and shuts it down GRACEFULLY on exit (POST
//     /api/shutdown with a local token, so the audit trail is flushed and the
//     background monitor is stopped first).
//
// Deliberately C# 5 (the compiler that ships with Windows' .NET Framework):
// no string interpolation, no null-conditional, no out vars, no local functions.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PEWorkbench
{
    static class Program
    {
        static string rootDir;
        static int port = 8798;
        static Process serverProc;
        static bool weSpawnedServer = false;
        static string shotFile = null;
        static bool selfTest = false;
        static MainForm mainForm;
        public static bool Quitting = false;

        static string LauncherLog
        {
            get { return Path.Combine(rootDir == null ? "." : rootDir, "logs", "launcher.log"); }
        }

        public static void LogLine(string message)
        {
            try
            {
                File.AppendAllText(LauncherLog,
                    "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + Environment.NewLine);
            }
            catch { /* never break on logging */ }
        }

        // In self-test mode (--shot) there must be no modal pop-ups: a blocked
        // dialogue would hang the automated lifecycle check. Messages go to the
        // launcher log instead.
        public static void Show(string message, string caption)
        {
            LogLine("ui: " + message.Replace(Environment.NewLine, " | "));
            if (shotFile == null)
            {
                MessageBox.Show(message, caption, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        [STAThread]
        static void Main(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--port" && i + 1 < args.Length) port = int.Parse(args[i + 1]);
                else if (args[i] == "--shot" && i + 1 < args.Length) shotFile = args[i + 1];
                else if (args[i] == "--theme" && i + 1 < args.Length) WindowTheme.Requested = WindowTheme.Normalize(args[i + 1]);
                else if (args[i] == "--selftest") selfTest = true;
                else if (args[i] == "--custom-titlebar") WindowTheme.CustomTitleBar = true;
            }

            // Headless verification. The window chrome is the one part of the
            // design system that no browser suite can reach - Windows draws the
            // frame, not the web engine - so it is asserted here instead. No
            // server is started and no window is shown.
            if (selfTest) { RunChromeSelfTest(); return; }

            bool createdNew;
            using (var mutex = new Mutex(true, "PE-Workbench-Desktop-Launcher", out createdNew))
            {
                if (!createdNew)
                {
                    Show("药物经济学工作台已在运行。", "PE-Workbench");
                    return;
                }

                rootDir = LocateRoot();
                if (rootDir == null)
                {
                    Show("找不到应用目录（src\\server.js）。\n请把 PEWorkbench.exe 放在 PE-Workbench 项目根目录。",
                        "PE-Workbench");
                    return;
                }

                LogLine("launcher start (port " + port + ")");
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                mainForm = new MainForm();
                Application.Run(mainForm);
                Quitting = true;
                ShutdownServer();
                mutex.ReleaseMutex();
            }
        }

        /// <summary>
        /// Assert that DWM accepts the window chrome - dark title bar, rounded
        /// corners, matching border. This is the half of the design system that
        /// CSS cannot reach, so it cannot be checked from a browser suite.
        ///
        /// The handle is created without Show(), so the build never flashes a
        /// window: DwmSetWindowAttribute works on a window that exists but is not
        /// visible.
        /// </summary>
        static void RunChromeSelfTest()
        {
            Console.WriteLine();
            Console.WriteLine("  PE-Workbench - window chrome self-test");
            Console.WriteLine("  " + new string('=', 62));
            Console.WriteLine();
            Console.WriteLine("  theme       " + WindowTheme.Describe());
            Console.WriteLine();

            bool ok = false;
            string detail = "";
            try
            {
                using (var probe = new Form())
                {
                    probe.ShowInTaskbar = false;
                    probe.FormBorderStyle = FormBorderStyle.FixedToolWindow;
                    IntPtr handle = probe.Handle;   // creates it, does not show it
                    if (handle == IntPtr.Zero) detail = "no window handle";
                    else ok = WindowTheme.Apply(probe, WindowTheme.IsDark());
                }
            }
            catch (Exception ex)
            {
                detail = ex.Message;
            }

            Console.WriteLine("  " + (ok ? "PASS" : "FAIL")
                + "  the window chrome can be themed (dark title bar, rounded corners)"
                + (detail.Length > 0 ? "  [" + detail + "]" : ""));
            Console.WriteLine();
            Console.WriteLine(ok
                ? "  WINDOW CHROME SELF-TEST PASSED"
                : "  WINDOW CHROME SELF-TEST FAILED");
            Console.WriteLine();
            Environment.Exit(ok ? 0 : 1);
        }

        static string LocateRoot()
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string[] candidates = new string[] {
                Path.Combine(exeDir, "src", "server.js"),
                Path.Combine(exeDir, "..", "src", "server.js"),
            };
            foreach (string c in candidates)
            {
                if (File.Exists(c))
                    return Path.GetFullPath(Path.GetDirectoryName(Path.GetDirectoryName(c)));
            }
            return null;
        }

        public static string RootDir { get { return rootDir; } }
        public static int Port { get { return port; } }
        public static string ShotFile { get { return shotFile; } }

        // --------------------------------------------------------- server ----
        public static string FindNode()
        {
            string[] candidates = new string[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
            };
            foreach (string c in candidates) if (File.Exists(c)) return c;
            string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in pathVar.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    string p = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(p)) return p;
                }
                catch { /* bad PATH entry */ }
            }
            return null;
        }

        /// Locate the WebView2 Evergreen runtime. The runtime may be registered
        /// only in the 32-bit registry view even on x64 systems (e.g. when it
        /// was installed by an x86 app), so we check both views and both
        /// standard install folders, returning a folder containing
        /// msedgewebview2.exe.
        public static string FindWebView2Runtime()
        {
            string[] registryRoots = new string[] {
                "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
            };
            foreach (string key in registryRoots)
            {
                try
                {
                    using (Microsoft.Win32.RegistryKey rk =
                        Microsoft.Win32.Registry.LocalMachine.OpenSubKey(key))
                    {
                        if (rk != null)
                        {
                            string pv = (rk.GetValue("pv") ?? "").ToString();
                            if (pv.Length > 0)
                            {
                                string dir = Path.Combine(
                                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                                    "Microsoft", "EdgeWebView", "Application", pv);
                                if (File.Exists(Path.Combine(dir, "msedgewebview2.exe"))) return dir;
                                dir = Path.Combine(
                                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                                    "Microsoft", "EdgeWebView", "Application", pv);
                                if (File.Exists(Path.Combine(dir, "msedgewebview2.exe"))) return dir;
                            }
                        }
                    }
                }
                catch { /* registry view not accessible */ }
            }
            // Last resort: scan the standard folders for the newest runtime.
            string best = null;
            string[] folders = new string[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    "Microsoft", "EdgeWebView", "Application"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Microsoft", "EdgeWebView", "Application"),
            };
            foreach (string folder in folders)
            {
                try
                {
                    if (!Directory.Exists(folder)) continue;
                    foreach (string v in Directory.GetDirectories(folder))
                    {
                        if (File.Exists(Path.Combine(v, "msedgewebview2.exe")))
                        {
                            if (best == null ||
                                string.Compare(Path.GetFileName(v), Path.GetFileName(best), true) > 0)
                                best = v;
                        }
                    }
                }
                catch { /* ignore */ }
            }
            return best;
        }

        public static bool HealthOk()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
                req.Timeout = 2500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return resp.StatusCode == HttpStatusCode.OK;
            }
            catch { return false; }
        }

        static void AppendLog(string file, string line, string stream)
        {
            try
            {
                using (var w = new StreamWriter(file, true, new UTF8Encoding(false)))
                {
                    w.WriteLine(DateTime.Now.ToString("HH:mm:ss") + " [" + stream + "] " + line);
                }
            }
            catch { /* never let logging break the app */ }
        }

        /// Start the server if nothing is listening; returns true when a ready
        /// server is available (freshly started or already running).
        public static bool EnsureServer()
        {
            if (HealthOk()) { weSpawnedServer = false; return true; }

            string node = FindNode();
            if (node == null)
            {
                Show("未找到 Node.js（需要 22.5 或更高版本）。\n请从 https://nodejs.org 安装后重试。",
                    "PE-Workbench");
                return false;
            }

            string logFile = Path.Combine(rootDir, "logs", "server.log");
            try { Directory.CreateDirectory(Path.GetDirectoryName(logFile)); } catch { /* best effort */ }
            try
            {
                File.AppendAllText(logFile, "\n===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
                    + " launcher: starting server =====\n", new UTF8Encoding(false));
            }
            catch { /* ignore */ }

            var psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = "src\\server.js";
            psi.WorkingDirectory = rootDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            try { psi.StandardOutputEncoding = new UTF8Encoding(false); } catch { }
            try { psi.StandardErrorEncoding = new UTF8Encoding(false); } catch { }
            psi.EnvironmentVariables["PE_PORT"] = port.ToString();
            if (psi.EnvironmentVariables["PE_BUILTIN_ACCOUNTS"] == null)
                psi.EnvironmentVariables["PE_BUILTIN_ACCOUNTS"] = "1";
            psi.EnvironmentVariables["PE_OPEN_BROWSER"] = "0";

            try
            {
                Process p = Process.Start(psi);
                serverProc = p;
                weSpawnedServer = true;
                LogLine("server spawned pid=" + p.Id);
                serverProc.OutputDataReceived += (s, e) => { if (e.Data != null) AppendLog(logFile, e.Data, "out"); };
                serverProc.ErrorDataReceived += (s, e) => { if (e.Data != null) AppendLog(logFile, e.Data, "err"); };
                serverProc.BeginOutputReadLine();
                serverProc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                Show("启动本地服务失败：\n" + ex.Message, "PE-Workbench");
                return false;
            }

            for (int i = 0; i < 90; i++)
            {
                Thread.Sleep(1000);
                bool ok = HealthOk();
                if (i % 10 == 9 || ok) LogLine("wait-ready t=" + (i + 1) + " healthy=" + ok
                    + " exited=" + (weSpawnedServer && serverProc.HasExited));
                if (ok) return true;
                if (weSpawnedServer && serverProc.HasExited) break;
            }
            Show("本地服务未能就绪。请查看日志：" + logFile, "PE-Workbench");
            return false;
        }

        /// Gracefully stop the server (token-protected /api/shutdown), falling
        /// back to killing the process tree we spawned.
        public static void ShutdownServer()
        {
            string tokenFile = Path.Combine(rootDir, "data", ".shutdown-token");
            string token = null;
            try { if (File.Exists(tokenFile)) token = File.ReadAllText(tokenFile).Trim(); } catch { }

            if (!string.IsNullOrEmpty(token))
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/shutdown");
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    req.Timeout = 3000;
                    byte[] body = Encoding.UTF8.GetBytes("{\"token\":\"" + token + "\"}");
                    req.ContentLength = body.Length;
                    using (Stream s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                    using (var resp = (HttpWebResponse)req.GetResponse()) { /* accepted */ }
                    for (int i = 0; i < 30; i++)
                    {
                        Thread.Sleep(500);
                        if (!HealthOk()) return;
                    }
                }
                catch { /* fall back to process kill */ }
            }

            if (weSpawnedServer && serverProc != null && !serverProc.HasExited)
            {
                try
                {
                    Process k = Process.Start("taskkill.exe", "/PID " + serverProc.Id + " /T /F");
                    if (k != null) k.WaitForExit(5000);
                }
                catch { /* ignore */ }
                try { serverProc.WaitForExit(2000); } catch { /* ignore */ }
            }
        }

        public static void RestartServer()
        {
            ShutdownServer();
            Thread.Sleep(1500);
            EnsureServer();
            if (mainForm != null) mainForm.Navigate();
        }

        public static void OpenLog()
        {
            try { Process.Start("notepad.exe", Path.Combine(rootDir, "logs", "server.log")); }
            catch { /* ignore */ }
        }
    }

    // ------------------------------------------------------------------ UI ---
    class MainForm : Form
    {
        WebView2 webView;
        NotifyIcon tray;

        /// <summary>
        /// Custom title bar message handling. MainForm already derives from Form,
        /// so it delegates to the shared WindowTheme helpers rather than
        /// inheriting WindowTheme.ChromeForm and changing its base class.
        ///
        /// WM_GETMINMAXINFO must be filled in by the default handler first, so it
        /// is the one message that runs base first and is adjusted after.
        /// </summary>
        protected override void WndProc(ref Message m)
        {
            if (WindowTheme.CustomTitleBar)
            {
                if (m.Msg == 0x0024)   // WM_GETMINMAXINFO
                {
                    base.WndProc(ref m);
                    WindowTheme.AdjustMinMaxInfo(this, ref m);
                    return;
                }
                if (WindowTheme.HandleNcCalcSize(ref m)) return;
                if (WindowTheme.HandleNcHitTest(this, ref m)) return;
            }
            base.WndProc(ref m);
        }

        public MainForm()
        {
            Text = "药物经济学工作台 · PE-Workbench";
            Width = 1440;
            Height = 900;
            StartPosition = FormStartPosition.CenterScreen;
            try
            {
                string iconFile = Path.Combine(Program.RootDir, "web", "favicon.ico");
                if (File.Exists(iconFile)) Icon = new Icon(iconFile);
            }
            catch { /* best effort */ }

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            Controls.Add(webView);

            // Window chrome. design-system.css themes everything inside the client
            // area; the title bar, the border and the corner radius are drawn by
            // DWM and are unreachable from CSS. Attach() hooks HandleCreated, so
            // StartPosition and Width/Height above are still honoured.
            WindowTheme.Attach(this);

            tray = new NotifyIcon();
            tray.Text = "药物经济学工作台";
            try
            {
                string iconFile = Path.Combine(Program.RootDir, "web", "favicon.ico");
                if (File.Exists(iconFile)) tray.Icon = new Icon(iconFile);
            }
            catch { /* best effort */ }
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开工作台", null, (s, e) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
            menu.Items.Add("查看服务日志", null, (s, e) => Program.OpenLog());
            menu.Items.Add("重启服务", null, (s, e) => Program.RestartServer());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, (s, e) =>
            {
                Program.Quitting = true;
                Program.ShutdownServer();
                tray.Visible = false;
                Application.Exit();
            });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => { Show(); WindowState = FormWindowState.Normal; Activate(); };

            Shown += async (s, e) => await InitializeAsync();
            FormClosing += OnClosing;
        }

        async System.Threading.Tasks.Task InitializeAsync()
        {
            Program.LogLine("InitializeAsync: start");
            bool serverOk = Program.EnsureServer();
            Program.LogLine("InitializeAsync: EnsureServer=" + serverOk);
            if (!serverOk) { Program.Quitting = true; Application.Exit(); return; }

            try
            {
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "PE-Workbench", "webview2");
                string runtime = Program.FindWebView2Runtime();
                Program.LogLine("InitializeAsync: WebView2 runtime folder = " + (runtime ?? "(registry discovery)"));

                // Let the control create its environment on the UI thread. The
                // loader then resolves the Evergreen runtime through the
                // registry; when the explicit folder is known we pin it.
                webView.CreationProperties = new CoreWebView2CreationProperties();
                webView.CreationProperties.UserDataFolder = userData;
                if (runtime != null) webView.CreationProperties.BrowserExecutableFolder = runtime;
                await webView.EnsureCoreWebView2Async();
                Program.LogLine("InitializeAsync: EnsureCoreWebView2Async done");

                // Keep the page in step with the window chrome. When the theme
                // follows Windows this stays Auto, which tracks the system live -
                // the same signal design-system.css reads via prefers-color-scheme.
                // Pinning it here would freeze the page while the title bar kept
                // following the system.
                try
                {
                    int? scheme = WindowTheme.PreferredColorScheme();
                    webView.CoreWebView2.Profile.PreferredColorScheme = !scheme.HasValue
                        ? CoreWebView2PreferredColorScheme.Auto
                        : (scheme.Value == 1 ? CoreWebView2PreferredColorScheme.Dark
                                             : CoreWebView2PreferredColorScheme.Light);
                    Program.LogLine("window theme: " + WindowTheme.Describe());
                }
                catch (Exception themeEx)
                {
                    Program.LogLine("PreferredColorScheme not applied: " + themeEx.Message);
                }

                webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;

                // Custom title bar, second half. Both pieces have to be in place
                // BEFORE the first navigation: Microsoft documents
                // IsNonClientRegionSupportEnabled as taking effect "after the next
                // navigation", and the shell marker has to be registered before the
                // document is created or the page paints one frame in the browser
                // layout. If the engine refuses the setting, the window keeps its
                // standard caption rather than ending up with nothing to drag it by.
                if (WindowTheme.CustomTitleBar)
                {
                    bool nonClientOk = false;
                    try
                    {
                        webView.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = true;
                        nonClientOk = webView.CoreWebView2.Settings.IsNonClientRegionSupportEnabled;
                    }
                    catch (Exception ncEx)
                    {
                        Program.LogLine("non-client region support unavailable: " + ncEx.Message);
                    }

                    if (nonClientOk && WindowTheme.ExtendFrameIntoClientArea(this))
                    {
                        try
                        {
                            // Awaited rather than .Wait()ed: the WebView2 task posts
                            // its continuation back to this UI thread, so blocking
                            // would deadlock.
                            await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                                WindowTheme.ShellMarkerScript());
                            Program.LogLine("custom title bar: enabled");
                        }
                        catch (Exception smEx)
                        {
                            Program.LogLine("shell marker not registered: " + smEx.Message);
                        }
                    }
                    else
                    {
                        Program.LogLine("custom title bar requested but not applied; keeping the system caption");
                    }
                }

                Navigate();
            }
            catch (Exception ex)
            {
                Program.LogLine("InitializeAsync failed: " + ex.Message);
                // WebView2 runtime missing or failed: explain, then fall back to
                // the system browser once, so the workbench still works.
                Program.Show("内嵌视图组件（WebView2 Runtime）不可用：\n" + ex.Message
                    + "\n\n将改用系统浏览器打开工作台。\n"
                    + "提示：安装或更新 Microsoft Edge WebView2 运行时后，可回到本窗口使用。",
                    "PE-Workbench");
                try
                {
                    Process.Start("http://127.0.0.1:" + Program.Port);
                }
                catch { /* ignore */ }
            }
        }

        async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            // Self-test switch (--shot): paint the window to a PNG and dump the
            // rendered page title so the build script can verify the UI really
            // painted, then restart the server (exercises the graceful shutdown
            // path) and exit.
            if (Program.ShotFile != null && !File.Exists(Program.ShotFile))
            {
                if (webView.CoreWebView2 != null && e.IsSuccess)
                {
                    try
                    {
                        string title = await webView.CoreWebView2.ExecuteScriptAsync("document.title || ''");
                        try { File.WriteAllText(Program.ShotFile + ".txt", "title=" + title); }
                        catch { /* ignore */ }
                    }
                    catch { /* ignore */ }
                }
                System.Threading.Tasks.Task.Run(delegate
                {
                    Thread.Sleep(3500);
                    try { CaptureWindow(Program.ShotFile); } catch { /* ignore */ }
                    Thread.Sleep(600);
                    try
                    {
                        BeginInvoke((Action)delegate
                        {
                            Program.Quitting = true;
                            Program.RestartServer();
                            Thread.Sleep(4000);
                            Program.ShutdownServer();
                            tray.Visible = false;
                            Application.Exit();
                        });
                    }
                    catch { /* window already gone */ }
                });
            }
        }

        public void Navigate()
        {
            if (webView.CoreWebView2 != null)
            {
                webView.CoreWebView2.Navigate("http://127.0.0.1:" + Program.Port);
            }
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            // Closing the window hides it to the tray; real exit happens from
            // the tray ("退出") or at user logoff - like a real desktop app.
            if (!Program.Quitting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
            if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing)
            {
                Program.Quitting = true;
                Program.ShutdownServer();
                tray.Visible = false;
            }
        }

        // ---------------------------------------------------- screenshot -----
        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")]
        static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        void CaptureWindow(string file)
        {
            RECT rc;
            if (!GetWindowRect(Handle, out rc)) return;
            int w = rc.Right - rc.Left, h = rc.Bottom - rc.Top;
            if (w <= 0 || h <= 0) return;
            using (var bmp = new Bitmap(w, h))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                try { PrintWindow(Handle, hdc, 2); } finally { g.ReleaseHdc(hdc); }
                bmp.Save(file, ImageFormat.Png);
            }
        }
    }
}