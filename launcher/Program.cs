using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace WowAddonButler
{
    internal static class Program
    {
        private static readonly object LogLock = new object();
        private static string _dataDir;
        private static string _logFile;

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                _dataDir = Path.Combine(appDir, "data");
                Directory.CreateDirectory(_dataDir);
                Directory.CreateDirectory(Path.Combine(_dataDir, "logs"));
                _logFile = Path.Combine(_dataDir, "logs", "launcher.log");
                Log("launcher start: " + appDir);

                string runtimeFile = Path.Combine(_dataDir, "runtime.json");
                Process nodeProcess = null;
                int port = GetHealthyPort(runtimeFile);
                if (port > 0)
                {
                    Log("reusing running server on port " + port);
                }
                else
                {
                    nodeProcess = StartNode(appDir);
                    if (nodeProcess == null)
                    {
                        ShowError("没有找到内置的 node.exe，程序文件不完整。请重新解压完整压缩包。");
                        return 1;
                    }
                    port = WaitForServer(runtimeFile, nodeProcess, 30000);
                    if (port <= 0)
                    {
                        ShowError("本地服务启动失败。\n\n请查看日志：\n" + _logFile);
                        KillProcess(nodeProcess);
                        return 1;
                    }
                }

                string url = "http://127.0.0.1:" + port + "/";
                Log("opening " + url);
                Process browser = null;
                try
                {
                    browser = StartBrowser(appDir, url);
                }
                catch (Exception browserError)
                {
                    Log("browser setup failed: " + browserError);
                    if (nodeProcess != null) KillProcess(nodeProcess);
                    ShowError("无法准备应用窗口。\n\n" + browserError.Message + "\n\n日志：" + _logFile);
                    return 1;
                }
                if (browser == null)
                {
                    try
                    {
                        Process.Start(url);
                    }
                    catch (Exception ex)
                    {
                        ShowError("没有找到 Microsoft Edge 或 Chrome，无法打开应用窗口。\n\n" + ex.Message);
                        if (nodeProcess != null) KillProcess(nodeProcess);
                        return 1;
                    }
                    ShowInfo("已用默认浏览器打开插件管家。\n关闭浏览器标签页后，本地服务仍会在后台运行；下次启动会自动复用。");
                    return 0;
                }

                browser.WaitForExit();
                Log("browser parent exited");
                if (nodeProcess != null && !HasBrowserProfileProcess(Path.Combine(_dataDir, "browser-profile")))
                {
                    // Edge/Chrome can hand the app window to an already-running
                    // browser process. Give that process time to appear before
                    // stopping the local server.
                    Thread.Sleep(1800);
                }
                if (nodeProcess != null)
                {
                    WaitForBrowserWindow(port);
                    KillProcess(nodeProcess);
                    try { File.Delete(runtimeFile); } catch { }
                }
                return 0;
            }
            catch (Exception ex)
            {
                Log("fatal: " + ex);
                ShowError("启动失败：\n" + ex.Message + "\n\n日志：" + _logFile);
                return 1;
            }
        }

        private static Process StartNode(string appDir)
        {
            string nodePath = Path.Combine(appDir, "node", "node.exe");
            string serverPath = Path.Combine(appDir, "server", "index.js");
            if (!File.Exists(nodePath) || !File.Exists(serverPath)) return null;

            var info = new ProcessStartInfo();
            info.FileName = nodePath;
            info.Arguments = "\"" + serverPath + "\"";
            info.WorkingDirectory = appDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            info.EnvironmentVariables["WOW_BUTLER_NO_OPEN"] = "1";
            info.EnvironmentVariables["WOW_BUTLER_DATA"] = _dataDir;
            info.EnvironmentVariables["NODE_ENV"] = "production";

            var process = new Process();
            process.StartInfo = info;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("server: " + e.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("server-err: " + e.Data);
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            Log("node started pid=" + process.Id);
            return process;
        }

        private static int WaitForServer(string runtimeFile, Process nodeProcess, int timeoutMs)
        {
            DateTime started = DateTime.UtcNow;
            while ((DateTime.UtcNow - started).TotalMilliseconds < timeoutMs)
            {
                if (nodeProcess != null && nodeProcess.HasExited)
                {
                    Log("node exited early code=" + nodeProcess.ExitCode);
                    return 0;
                }
                int port = GetHealthyPort(runtimeFile);
                if (port > 0) return port;
                Thread.Sleep(300);
            }
            return 0;
        }

        private static int GetHealthyPort(string runtimeFile)
        {
            try
            {
                if (!File.Exists(runtimeFile)) return 0;
                string text = File.ReadAllText(runtimeFile, Encoding.UTF8);
                Match match = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
                if (!match.Success) return 0;
                int port;
                if (!int.TryParse(match.Groups[1].Value, out port) || port <= 0) return 0;
                if (IsHealthy(port)) return port;
            }
            catch
            {
                // stale or partially written runtime file
            }
            return 0;
        }

        private static bool IsHealthy(int port)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
                request.Timeout = 1200;
                request.ReadWriteTimeout = 1200;
                request.Proxy = null;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string body = reader.ReadToEnd();
                    return body.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private static Process StartBrowser(string appDir, string url)
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe")
            };

            string browser = null;
            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate)) { browser = candidate; break; }
            }
            if (browser == null) return null;

            string profile = Path.Combine(_dataDir, "browser-profile");
            Directory.CreateDirectory(profile);

            var info = new ProcessStartInfo();
            info.FileName = browser;
            info.Arguments = "--app=" + url +
                " --user-data-dir=\"" + profile + "\"" +
                " --no-first-run --no-default-browser-check" +
                " --no-proxy-server" +
                " --disable-component-update" +
                " --disable-background-networking" +
                " --disable-background-mode" +
                " --disable-extensions" +
                " --disable-features=HttpsUpgrades,Translate,msEdgeSidebarV2" +
                " --window-size=1460,980";
            info.UseShellExecute = false;
            info.CreateNoWindow = false;
            try
            {
                var process = Process.Start(info);
                Log("browser started pid=" + (process == null ? 0 : process.Id));
                return process;
            }
            catch (Exception ex)
            {
                Log("browser start failed: " + ex);
                return null;
            }
        }

        private static bool HasBrowserProfileProcess(string profile)
        {
            try
            {
                string query = "SELECT CommandLine FROM Win32_Process WHERE Name='msedge.exe' OR Name='chrome.exe'";
                using (var searcher = new ManagementObjectSearcher(query))
                using (ManagementObjectCollection results = searcher.Get())
                {
                    foreach (ManagementBaseObject item in results)
                    {
                        string commandLine = Convert.ToString(item["CommandLine"]);
                        if (!string.IsNullOrEmpty(commandLine) &&
                            commandLine.IndexOf(profile, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            return true;
                        }
                    }
                }
                return false;
            }
            catch (Exception ex)
            {
                // If WMI is unavailable, keep the server alive rather than
                // killing it while the application window is still opening.
                Log("WMI query failed, keeping server alive: " + ex.Message);
                return true;
            }
        }

        private static void WaitForBrowserWindow(int port)
        {
            string profile = Path.Combine(_dataDir, "browser-profile");
            int missing = 0;
            for (int i = 0; i < 12 * 60 * 60; i++)
            {
                Thread.Sleep(1000);
                if (!IsHealthy(port))
                {
                    Log("server stopped while browser was open");
                    return;
                }
                if (HasBrowserProfileProcess(profile))
                {
                    missing = 0;
                }
                else
                {
                    missing += 1;
                    if (missing >= 3)
                    {
                        Log("browser window closed");
                        return;
                    }
                }
            }
            Log("browser session reached safety timeout");
        }

        private static void KillProcess(Process process)
        {
            try
            {
                if (process == null || process.HasExited) return;
                var info = new ProcessStartInfo();
                info.FileName = "taskkill.exe";
                info.Arguments = "/PID " + process.Id + " /T /F";
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                using (var killer = Process.Start(info))
                {
                    if (killer != null) killer.WaitForExit(4000);
                }
                Log("killed pid=" + process.Id);
            }
            catch (Exception ex)
            {
                Log("kill failed: " + ex.Message);
            }
        }

        private static void Log(string message)
        {
            try
            {
                lock (LogLock)
                {
                    File.AppendAllText(
                        _logFile,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine,
                        Encoding.UTF8);
                }
            }
            catch
            {
                // logging must never prevent startup
            }
        }

        private static void ShowError(string message)
        {
            MessageBox.Show(message, "魔兽插件管家", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private static void ShowInfo(string message)
        {
            MessageBox.Show(message, "魔兽插件管家", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
