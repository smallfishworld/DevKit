using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/**
 * Stands in for DevKit.exe while the real updater helper runs against throwaway directories
 * (tests/probes/updater-harness.cjs). Which build this is comes from the marker appended to the image.
 */
internal static class FakeDevKit
{
    private const string Prefix = "--user-data-dir=";

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--run") return Wait(args[1], "exit", 60000);
            if (args.Length >= 3 && args[0] == "--hold") return Hold(args[1], args[2], args.Length > 3 && args[3] == "--dir");
            if (args.Length == 1 && args[0].StartsWith(Prefix, StringComparison.Ordinal)) return Started(args[0].Substring(Prefix.Length));
            return 2;
        }
        catch (Exception error)
        {
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "devkit-fake-app-errors.log"), error + Environment.NewLine); }
            catch (IOException) { }
            return 3;
        }
    }

    private static string Build()
    {
        string text = Encoding.UTF8.GetString(File.ReadAllBytes(Process.GetCurrentProcess().MainModule.FileName));
        int start = text.LastIndexOf("DEVKIT-FAKE:", StringComparison.Ordinal);
        if (start < 0) return "unmarked";
        int end = text.IndexOf('\n', start);
        return text.Substring(start + "DEVKIT-FAKE:".Length, end - start - "DEVKIT-FAKE:".Length).Trim();
    }

    /** Launched by the helper: either the new version confirming its start, or the old one after a rollback. */
    private static int Started(string profile)
    {
        string handoff = Environment.GetEnvironmentVariable("DEVKIT_UPDATE_HANDOFF");
        string version = Environment.GetEnvironmentVariable("DEVKIT_UPDATE_VERSION");
        if (handoff == null)
        {
            File.WriteAllText(Path.Combine(profile, "relaunched"), Build());
            return Wait(profile, "exit", 5000);
        }
        string planFile = Path.Combine(profile, "startup");
        if (File.Exists(planFile) && File.ReadAllText(planFile).Trim() == "fail") return 1;
        Thread.Sleep(150);
        File.WriteAllText(Path.Combine(handoff, "started"), version);
        // Like a real upgrade, the new version stays up until it is closed.
        return Wait(profile, "exit", 20000);
    }

    /** Holds a file (or, with --dir, a folder the way Explorer does) until the harness releases it. */
    private static int Hold(string control, string path, bool directory)
    {
        if (directory)
        {
            using (SafeFileHandle handle = CreateFile(path, 0x80000000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
            {
                if (handle.IsInvalid) return 4;
                File.WriteAllText(Path.Combine(control, "held"), "");
                return Wait(control, "release", 60000);
            }
        }
        using (var held = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            File.WriteAllText(Path.Combine(control, "held"), "");
            return Wait(control, "release", 60000);
        }
    }

    private static int Wait(string directory, string name, int timeout)
    {
        string file = Path.Combine(directory, name);
        var elapsed = Stopwatch.StartNew();
        while (elapsed.ElapsedMilliseconds < timeout)
        {
            if (File.Exists(file)) return 0;
            Thread.Sleep(20);
        }
        return 5;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
}
