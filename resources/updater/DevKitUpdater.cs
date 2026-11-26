using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class DevKitUpdater
{
    private const string Inventory = "resources/devkit-update-files.txt";
    private const long MaxExpandedBytes = 2L * 1024 * 1024 * 1024;
    private static readonly StringComparer PathComparer = StringComparer.OrdinalIgnoreCase;

    /** The installation cannot be replaced where it is. Reason is reported through the "ready" signal. */
    private sealed class DirectoryChanged : Exception
    {
        public readonly string Reason;
        public readonly string Detail;
        public DirectoryChanged(string reason, string detail) : base(detail ?? "Managed directory changed.")
        {
            Reason = reason;
            Detail = detail;
        }
    }

    /** The swap kept failing although everything was checked beforehand: something else holds the directory. */
    private sealed class SwapBlocked : Exception
    {
        public SwapBlocked(Exception inner) : base("Managed directory could not be replaced.", inner) { }
    }

    private static int Main(string[] args)
    {
        if (args.Length != 9 || (args[0] != "portable" && args[0] != "zip")) return 1;
        bool portable = args[0] == "portable";
        string executable = Path.GetFullPath(args[1]);
        string target = portable ? executable : Path.GetDirectoryName(executable);
        string parent = Path.GetDirectoryName(target);
        string handoff = Path.GetFullPath(args[7]);
        string cache = Path.GetDirectoryName(handoff);
        string nonce = Guid.NewGuid().ToString("N");
        string stage = Path.Combine(parent, ".devkit-stage-" + nonce);
        string backup = Path.Combine(parent, ".devkit-backup-" + nonce + (portable ? ".exe" : ""));
        string result = Path.Combine(cache, "apply-error");
        string userData = Path.GetFullPath(args[8]);
        // What the user put next to the program. It travels with the old directory and is returned afterwards.
        List<string> extras = null;
        bool applying = false;
        try
        {
            using (Process electron = OpenProcess(args[5], portable ? null : executable))
            using (Process launcher = portable ? OpenProcess(args[6], executable, true) : null)
            {
                AssertLocalPath(target);
                if (!portable) extras = ReadUnmanaged(target, true);
                StagePackage(args[2], args[3], portable, stage);
                if (!portable)
                {
                    AssertNoCollision(stage, extras);
                    AssertNotHeld(target, extras);
                }
                WriteSignal(handoff, "ready", "ok");
                if (!electron.WaitForExit(120000)) throw new IOException("DevKit is still shutting down.");
                if (launcher != null && !launcher.WaitForExit(20000)) throw new IOException("Portable launcher is still in use.");
            }

            if (File.Exists(Path.Combine(handoff, "cancel")) || !File.Exists(Path.Combine(handoff, "apply"))) return 1;
            applying = true;
            AssertLocalPath(target);
            // The directory may have changed while DevKit was shutting down.
            if (!portable) extras = ReadUnmanaged(target, true);
            try { ReplaceWithRetry(portable, stage, target, backup); }
            catch (IOException error) { throw new SwapBlocked(error); }
            catch (UnauthorizedAccessException error) { throw new SwapBlocked(error); }
            using (Process started = StartDevKit(executable, userData, handoff, args[4]))
            {
                if (WaitForStartup(started, handoff, args[4]))
                {
                    if (portable) DeleteStage(backup, true);
                    else ReturnExtras(backup, target, extras, cache);
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
                TryWriteSignal(handoff, "ready", dirError != null ? dirError.Reason : "failed");
            }
            bool committed = File.Exists(Path.Combine(handoff, "apply"));
            if (committed)
            {
                // Always rewritten, so a reason never outlives the failure that caused it.
                try { File.WriteAllText(Path.Combine(cache, "apply-detail"), error is SwapBlocked ? "locked" : ""); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

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
            ReadUnmanaged(stage, false);
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

    /**
     * Compares a DevKit directory with the inventory written at packaging time and returns what the package
     * does not own. An existing installation may hold anything the user put next to it — and may lack files,
     * which the new version brings back — while a freshly staged package has to match its inventory exactly.
     */
    private static List<string> ReadUnmanaged(string root, bool existing)
    {
        root = FileSystemPath(root);
        try
        {
            string inventory = Path.Combine(root, Inventory.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(Path.Combine(root, "DevKit.exe")) ||
                !File.Exists(Path.Combine(root, "resources", "app.asar")) ||
                !File.Exists(inventory) ||
                (File.GetAttributes(inventory) & FileAttributes.ReparsePoint) != 0)
                throw new DirectoryChanged("directory", "缺少核心程序文件或清单异常");
            var expected = new HashSet<string>(File.ReadAllLines(inventory), PathComparer);
            // An inventory that does not list the application would turn every program file into a user file.
            if (!expected.Contains("DevKit.exe")) throw new DirectoryChanged("directory", "缺少核心程序文件或清单异常");
            expected.Add(Inventory);
            var unmanaged = new List<string>();
            VerifyDirectory(root, "", expected, unmanaged);
            if (!existing && unmanaged.Count + expected.Count > 0)
                throw new DirectoryChanged("directory", Describe(unmanaged, expected));
            return unmanaged;
        }
        catch (IOException)
        {
            if (existing) throw new DirectoryChanged("directory", null);
            throw;
        }
    }

    /** Files as "a/b.txt", directories as "a/b/" */
    private static void VerifyDirectory(string root, string prefix, HashSet<string> expected, List<string> unmanaged)
    {
        foreach (string path in Directory.EnumerateFileSystemEntries(root))
        {
            string name = Path.GetFileName(path);
            string relative = prefix + name;
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new DirectoryChanged("directory", "符号链接: " + relative);
            if ((attributes & FileAttributes.Directory) == 0)
            {
                if (!expected.Remove(relative)) unmanaged.Add(relative);
            }
            else if (!expected.Remove(relative + "/"))
            {
                unmanaged.Add(relative + "/");
            }
            else
            {
                VerifyDirectory(path, relative + "/", expected, unmanaged);
            }
        }
    }

    private static string Describe(List<string> unmanaged, HashSet<string> expected)
    {
        var parts = new List<string>();
        if (unmanaged.Count > 0) parts.Add("多出: " + Names(unmanaged));
        if (expected.Count > 0)
        {
            var missing = new List<string>();
            foreach (string item in expected) missing.Add(item);
            parts.Add("缺失: " + Names(missing));
        }
        return string.Join("; ", parts);
    }

    private static string Names(List<string> items)
    {
        int shown = Math.Min(items.Count, 3);
        var leading = new string[shown];
        for (int index = 0; index < shown; index++) leading[index] = items[index];
        return string.Join(", ", leading) + (items.Count > shown ? " 等共 " + items.Count + " 项" : "");
    }

    /** A user file cannot give way to a file the new version ships, so refuse before DevKit quits. */
    private static void AssertNoCollision(string stage, List<string> extras)
    {
        var colliding = new List<string>();
        foreach (string extra in extras)
        {
            string path = Path.Combine(FileSystemPath(stage), Relative(extra));
            if (File.Exists(path) || Directory.Exists(path)) colliding.Add(extra);
        }
        if (colliding.Count > 0) throw new DirectoryChanged("collision", Names(colliding));
    }

    /**
     * Windows cannot rename the installation directory while anything inside it is open, so a user file held
     * elsewhere would only fail once DevKit had already quit. Find out while the application is still running.
     */
    private static void AssertNotHeld(string target, List<string> extras)
    {
        for (int attempt = 0; ; attempt++)
        {
            var held = new List<string>();
            foreach (string extra in extras) CollectHeld(target, extra.TrimEnd('/'), held);
            if (held.Count == 0) return;
            // A scanner or an indexer may have a file only for a moment.
            if (attempt == 7) throw new DirectoryChanged("locked", Names(held));
            Thread.Sleep(250);
        }
    }

    private static void CollectHeld(string root, string relative, List<string> held)
    {
        string path = Path.Combine(FileSystemPath(root), Relative(relative));
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.Directory) == 0)
        {
            if (IsHeld(path, false) && held.Count < 3) held.Add(relative);
            return;
        }
        if (IsHeld(path, true) && held.Count < 3) held.Add(relative + "/");
        // A link inside the user's own folder is moved as a link and never followed.
        if ((attributes & FileAttributes.ReparsePoint) != 0) return;
        foreach (string entry in Directory.EnumerateFileSystemEntries(path))
            CollectHeld(root, relative + "/" + Path.GetFileName(entry), held);
    }

    private const uint DeleteAccess = 0x00010000, OpenExisting = 3, BackupSemantics = 0x02000000;

    /**
     * Asks for delete access while sharing nothing: the open fails with a sharing violation for exactly as long as
     * another process has the entry open, whatever that process lets others do.
     */
    private static bool IsHeld(string path, bool directory)
    {
        using (SafeFileHandle handle = CreateFile(path, DeleteAccess, 0, IntPtr.Zero, OpenExisting,
            directory ? BackupSemantics : 0, IntPtr.Zero))
        {
            if (!handle.IsInvalid) return false;
            int error = Marshal.GetLastWin32Error();
            // Sharing and lock violations, and a mapped section, each block the directory rename as well.
            // Anything else (access denied, an entry that disappeared meanwhile) is left to the update itself.
            return error == 32 || error == 33 || error == 1224;
        }
    }

    private static string Relative(string extra)
    {
        return extra.Replace('/', Path.DirectorySeparatorChar);
    }

    /**
     * Puts the user's files back into the new version. Whatever cannot return stays in the backup directory,
     * which is then kept and reported instead of deleted. Nothing here may fail the update: the new version
     * is already running.
     */
    private static void ReturnExtras(string backup, string target, List<string> extras, string cache)
    {
        try
        {
            foreach (string extra in extras) ReturnEntry(backup, target, extra);
            List<string> kept = ReadUnmanaged(backup, true);
            if (kept.Count == 0) DeleteStage(backup, false);
            else
            {
                var notice = new StringBuilder(backup);
                foreach (string extra in kept) notice.AppendLine().Append(extra);
                TryWriteSignal(cache, "apply-leftover", notice.ToString());
            }
        }
        catch (Exception) { }
    }

    /** Moves one unmanaged entry back; false when it has to stay behind. */
    private static bool ReturnEntry(string backup, string target, string extra)
    {
        string relative = Relative(extra.TrimEnd('/'));
        string source = Path.Combine(FileSystemPath(backup), relative);
        string destination = Path.Combine(FileSystemPath(target), relative);
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                bool moved = Directory.Exists(source);
                if (!moved && !File.Exists(source)) return true;
                // A same-named entry in the new version was refused before DevKit quit.
                if (File.Exists(destination) || Directory.Exists(destination)) return false;
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                if (moved) Directory.Move(source, destination);
                else File.Move(source, destination);
                return true;
            }
            catch (Exception error)
            {
                // A scanner or an indexer may hold the freshly renamed entry for a moment.
                if (!(error is IOException || error is UnauthorizedAccessException) || attempt == 19) return false;
                Thread.Sleep(250);
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

    private static void WriteSignal(string directory, string name, string value)
    {
        string destination = Path.Combine(directory, name);
        File.WriteAllText(destination + ".tmp", value);
        File.Move(destination + ".tmp", destination);
    }

    private static void TryWriteSignal(string directory, string name, string value)
    {
        try { WriteSignal(directory, name, value); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
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
