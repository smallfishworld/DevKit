using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class DevKitUpdater
{
    private const string Inventory = "resources/devkit-update-files.txt";
    private const long MaxExpandedBytes = 2L * 1024 * 1024 * 1024;
    private static readonly StringComparer PathComparer = StringComparer.OrdinalIgnoreCase;
    private static readonly HashSet<string> IgnoredSystemFiles = new HashSet<string>(PathComparer)
    {
        "desktop.ini",
        "thumbs.db"
    };

    private sealed class DirectoryChanged : Exception
    {
        public readonly string Detail;
        public DirectoryChanged(string detail = null) : base(detail ?? "Managed directory changed.")
        {
            Detail = detail;
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length != 9 || (args[0] != "portable" && args[0] != "zip")) return 1;
        bool portable = args[0] == "portable";
        string executable = Path.GetFullPath(args[1]);
        string target = portable ? executable : Path.GetDirectoryName(executable);
        string parent = Path.GetDirectoryName(target);
        string handoff = Path.GetFullPath(args[7]);
        string nonce = Guid.NewGuid().ToString("N");
        string stage = Path.Combine(parent, ".devkit-stage-" + nonce);
        string backup = Path.Combine(parent, ".devkit-backup-" + nonce + (portable ? ".exe" : ""));
        string result = Path.Combine(Path.GetDirectoryName(handoff), "apply-error");
        string userData = Path.GetFullPath(args[8]);
        bool applying = false;
        try
        {
            using (Process electron = OpenProcess(args[5], portable ? null : executable))
            using (Process launcher = portable ? OpenProcess(args[6], executable, true) : null)
            {
                AssertLocalPath(target);
                if (!portable) AssertManagedDirectory(target, true);
                StagePackage(args[2], args[3], portable, stage);
                WriteSignal(handoff, "ready", "ok");
                if (!electron.WaitForExit(120000)) throw new IOException("DevKit is still shutting down.");
                if (launcher != null && !launcher.WaitForExit(20000)) throw new IOException("Portable launcher is still in use.");
            }

            if (File.Exists(Path.Combine(handoff, "cancel")) || !File.Exists(Path.Combine(handoff, "apply"))) return 1;
            applying = true;
            AssertLocalPath(target);
            if (!portable) AssertManagedDirectory(target, true);
            ReplaceWithRetry(portable, stage, target, backup);
            using (Process started = StartDevKit(executable, userData, handoff, args[4]))
            {
                if (WaitForStartup(started, handoff, args[4]))
                {
                    if (portable) DeleteStage(backup, true);
                    else TryDeleteManagedBackup(backup);
                    return 0;
                }
                if (!started.HasExited)
                {
                    // Give slow systems more time to initialize and keep the backup available.
                    File.WriteAllText(result, "New process did not confirm startup. Backup at " + backup);
                    return 1;
                }
            }
            throw new IOException("New version exited before its window was ready.");
        }
        catch (Exception error)
        {
            TryWriteSignal(handoff, "error", error.ToString());
            if (!applying)
            {
                var dirError = error as DirectoryChanged;
                if (dirError != null && !string.IsNullOrEmpty(dirError.Detail))
                    TryWriteSignal(handoff, "directory-detail", dirError.Detail);
                TryWriteSignal(handoff, "ready", dirError != null ? "directory" : "failed");
            }
            bool committed = File.Exists(Path.Combine(handoff, "apply"));
            if (committed)
            {
                try
                {
                    if (applying) RestoreBackup(portable, target, backup, stage);
                }
                catch (Exception restoreError)
                {
                    error = new AggregateException(error, restoreError);
                }
                try { File.WriteAllText(result, error + Environment.NewLine + "Backup: " + backup); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                try { using (StartDevKit(executable, userData, null, null)) { } }
                catch (Exception launchError)
                {
                    try { File.AppendAllText(result, Environment.NewLine + launchError); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
            }
            return 1;
        }
        finally
        {
            DeleteStage(stage, portable);
        }
    }

    private static Process OpenProcess(string id, string expectedPath, bool allowExited = false)
    {
        int pid;
        if (!int.TryParse(id, out pid) || pid <= 0) throw new IOException("Invalid application process ID.");
        Process process;
        try { process = Process.GetProcessById(pid); }
        catch (ArgumentException)
        {
            if (allowExited) return null;
            throw;
        }
        try
        {
            // Open the handle while the app is alive. A recycled PID cannot take its place.
            IntPtr handle = process.Handle;
            if (handle == IntPtr.Zero) throw new IOException("Unable to open application process.");
            if (expectedPath != null)
            {
                // The NSIS portable launcher is 32-bit. Query its executable without enumerating modules.
                var image = new StringBuilder(32768);
                int length = image.Capacity;
                if (!QueryFullProcessImageName(handle, 0, image, ref length))
                    throw new IOException("Unable to identify the application process. Windows error: " + Marshal.GetLastWin32Error());
                // Windows may report an executable using 8.3 names even when it was launched by its long path.
                if (!PathComparer.Equals(LongPath(image.ToString()), LongPath(expectedPath)))
                    throw new IOException("Unexpected application process path: " + image);
            }
            return process;
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int length);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathName(string path, StringBuilder longPath, uint capacity);

    private static string LongPath(string path)
    {
        var expanded = new StringBuilder(32768);
        uint length = GetLongPathName(path, expanded, (uint)expanded.Capacity);
        if (length == 0 || length >= expanded.Capacity)
            throw new IOException("Unable to resolve the application path. Windows error: " + Marshal.GetLastWin32Error());
        return expanded.ToString();
    }

    private static void AssertLocalPath(string target)
    {
        if (target.StartsWith(@"\\", StringComparison.Ordinal)) throw new IOException("Network paths are unsupported.");
        for (string current = target; current != null; current = Path.GetDirectoryName(current))
        {
            if ((File.GetAttributes(FileSystemPath(current)) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("A path redirects outside the application directory.");
        }
    }

    private static string FileSystemPath(string path)
    {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static void StagePackage(string archive, string expectedHash, bool portable, string stage)
    {
        using (var source = new FileStream(FileSystemPath(archive), FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var sha256 = SHA256.Create())
        {
            string actualHash = BitConverter.ToString(sha256.ComputeHash(source)).Replace("-", "");
            if (!actualHash.Equals(expectedHash, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Release package hash does not match.");
            source.Position = 0;
            if (portable)
            {
                using (var output = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    source.CopyTo(output);
                    output.Flush(true);
                }
                return;
            }

            stage = FileSystemPath(stage);
            Directory.CreateDirectory(stage);
            var seen = new HashSet<string>(PathComparer);
            long total = 0;
            using (var zip = new ZipArchive(source, ZipArchiveMode.Read, true))
            {
                foreach (var entry in zip.Entries)
                {
                    string path = entry.FullName.Replace('\\', '/');
                    bool directory = path.EndsWith("/", StringComparison.Ordinal);
                    string relative = directory ? path.Substring(0, path.Length - 1) : path;
                    if (!IsSafeRelativePath(relative) || !seen.Add(relative) || entry.Length > MaxExpandedBytes - total)
                        throw new IOException("Unsafe or oversized ZIP entry.");
                    total += entry.Length;
                    string destination = Path.Combine(stage, relative.Replace('/', Path.DirectorySeparatorChar));
                    if (directory)
                    {
                        Directory.CreateDirectory(destination);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (var input = entry.Open())
                    using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        input.CopyTo(output);
                        if (output.Length != entry.Length) throw new IOException("Incomplete ZIP entry.");
                    }
                }
            }
            AssertManagedDirectory(stage, false);
        }
    }

    private static bool IsSafeRelativePath(string value)
    {
        if (String.IsNullOrEmpty(value)) return false;
        foreach (string part in value.Split('/'))
        {
            if (part.Length == 0 || part.EndsWith(".") || part.EndsWith(" ") ||
                part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                return false;
            string name = part.Split('.')[0].ToUpperInvariant();
            if (name == "CON" || name == "PRN" || name == "AUX" || name == "NUL" ||
                (name.Length == 4 && (name.StartsWith("COM") || name.StartsWith("LPT")) && Char.IsDigit(name[3])))
                return false;
        }
        return true;
    }

    private static void AssertManagedDirectory(string root, bool existing)
    {
        root = FileSystemPath(root);
        try
        {
            string inventory = Path.Combine(root, Inventory.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(Path.Combine(root, "DevKit.exe")) ||
                !File.Exists(Path.Combine(root, "resources", "app.asar")) ||
                (File.GetAttributes(inventory) & FileAttributes.ReparsePoint) != 0)
                throw new DirectoryChanged("缺少核心程序文件或清单异常");
            var expected = new HashSet<string>(File.ReadAllLines(inventory), PathComparer);
            expected.Add(Inventory);
            var unexpected = new List<string>();
            VerifyDirectory(root, "", expected, existing, unexpected);
            if (unexpected.Count > 0 || expected.Count > 0)
            {
                var parts = new List<string>();
                if (unexpected.Count > 0) parts.Add("多出: " + string.Join(", ", unexpected));
                if (expected.Count > 0)
                {
                    var missing = new List<string>();
                    foreach (string item in expected)
                    {
                        missing.Add(item);
                        if (missing.Count == 3) break;
                    }
                    parts.Add("缺失: " + string.Join(", ", missing));
                }
                throw new DirectoryChanged(string.Join("; ", parts));
            }
        }
        catch (IOException)
        {
            if (existing) throw new DirectoryChanged();
            throw;
        }
    }

    private static void VerifyDirectory(string root, string prefix, HashSet<string> expected, bool existing, List<string> unexpected)
    {
        foreach (string path in Directory.EnumerateFileSystemEntries(root))
        {
            string name = Path.GetFileName(path);
            string relative = prefix + name;
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new DirectoryChanged("符号链接: " + relative);
            if ((attributes & FileAttributes.Directory) == 0)
            {
                if (existing && IgnoredSystemFiles.Contains(name)) continue;
                if (!expected.Remove(relative) && unexpected.Count < 3) unexpected.Add(relative);
            }
            else
            {
                if (!expected.Remove(relative + "/"))
                {
                    if (unexpected.Count < 3) unexpected.Add(relative + "/");
                    continue;
                }
                VerifyDirectory(path, relative + "/", expected, existing, unexpected);
            }
        }
    }

    private static void ReplaceWithRetry(bool portable, string stage, string target, string backup)
    {
        // 最多重试 48 次（约 12 秒），兼容 Windows Defender 扫描或文件索引器短暂占锁
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                if (portable) File.Replace(stage, target, backup);
                else
                {
                    Directory.Move(target, backup);
                    Directory.Move(stage, target);
                }
                return;
            }
            catch (Exception ex)
            {
                if (!(ex is IOException || ex is UnauthorizedAccessException)) throw;
                if (attempt == 47 || File.Exists(backup) || Directory.Exists(backup)) throw;
                Thread.Sleep(250);
            }
        }
    }

    private static void RestoreBackup(bool portable, string target, string backup, string stage)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                if (portable && File.Exists(backup))
                {
                    if (File.Exists(target)) File.Replace(backup, target, null);
                    else File.Move(backup, target);
                }
                if (!portable && Directory.Exists(backup))
                {
                    if (Directory.Exists(target)) Directory.Move(target, stage);
                    Directory.Move(backup, target);
                }
                return;
            }
            catch (Exception ex)
            {
                if (!(ex is IOException || ex is UnauthorizedAccessException)) throw;
                if (attempt == 19) throw;
                Thread.Sleep(250);
            }
        }
    }

    private static Process StartDevKit(string file, string userData, string handoff, string version)
    {
        // Backslashes preceding the closing quote must be doubled on the Windows command line.
        string dataArg = userData.TrimEnd('\\');
        dataArg += new string('\\', 2 * (userData.Length - dataArg.Length));
        var start = new ProcessStartInfo(file, "\"--user-data-dir=" + dataArg + "\"")
        {
            WorkingDirectory = Path.GetDirectoryName(file),
            UseShellExecute = false
        };
        start.EnvironmentVariables.Remove("DEVKIT_UPDATE_HANDOFF");
        start.EnvironmentVariables.Remove("DEVKIT_UPDATE_VERSION");
        if (handoff != null)
        {
            start.EnvironmentVariables["DEVKIT_UPDATE_HANDOFF"] = handoff;
            start.EnvironmentVariables["DEVKIT_UPDATE_VERSION"] = version;
        }
        return Process.Start(start);
    }

    private static bool WaitForStartup(Process process, string handoff, string version)
    {
        string signal = Path.Combine(handoff, "started");
        var elapsed = Stopwatch.StartNew();
        while (elapsed.ElapsedMilliseconds < 120000)
        {
            try { if (File.ReadAllText(signal) == version) return true; }
            catch (IOException) { }
            if (process.WaitForExit(250)) return false;
        }
        return false;
    }

    private static void WriteSignal(string handoff, string name, string value)
    {
        string destination = Path.Combine(handoff, name);
        File.WriteAllText(destination + ".tmp", value);
        File.Move(destination + ".tmp", destination);
    }

    private static void TryWriteSignal(string handoff, string name, string value)
    {
        try { WriteSignal(handoff, name, value); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteManagedBackup(string path)
    {
        try { AssertManagedDirectory(path, true); }
        catch (DirectoryChanged) { return; }
        catch (UnauthorizedAccessException) { return; }
        DeleteStage(path, false);
    }

    private static void DeleteStage(string path, bool portable)
    {
        try
        {
            if (portable) File.Delete(path);
            else
            {
                string directory = FileSystemPath(path);
                if (Directory.Exists(directory)) Directory.Delete(directory, true);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
