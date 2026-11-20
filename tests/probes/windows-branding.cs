// Read the real HWND rather than mocking Electron's setters.
// https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-shgetpropertystoreforwindow
// https://learn.microsoft.com/windows/win32/properties/props-system-appusermodel-id
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DevKitBrandingProbe
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey
    {
        public Guid Format;
        public uint Id;
        public PropertyKey(uint id)
        {
            Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            Id = id;
        }
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Value;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("shell32.dll")]
    static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

    [StructLayout(LayoutKind.Sequential)]
    struct IconInfo
    {
        public int IsIcon;
        public uint XHotspot, YHotspot;
        public IntPtr Mask, Color;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Bitmap
    {
        public int Type, Width, Height, WidthBytes;
        public ushort Planes, BitsPixel;
        public IntPtr Bits;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BitmapInfo
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, BitCount;
        public uint Compression, SizeImage;
        public int XPelsPerMeter, YPelsPerMeter;
        public uint ClrUsed, ClrImportant, Colors;
    }
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
    [DllImport("gdi32.dll", EntryPoint = "GetObjectW")]
    static extern int GetObject(IntPtr bitmap, int size, out Bitmap info);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr item);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr item);
    [DllImport("gdi32.dll", SetLastError = true)]
    static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage,
        out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height,
        uint step, IntPtr background, uint flags);

    public static IntPtr FindWindow(uint[] processes)
    {
        var allowed = new HashSet<uint>(processes);
        IntPtr found = IntPtr.Zero;
        EnumWindows((window, unused) => {
            uint process;
            GetWindowThreadProcessId(window, out process);
            if (!allowed.Contains(process) || !IsWindowVisible(window)) return true;
            var name = new StringBuilder(128);
            GetClassName(window, name, name.Capacity);
            if (!name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static Dictionary<string, string> ReadProperties(IntPtr window)
    {
        var iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref iid, out store));
        try
        {
            var result = new Dictionary<string, string>();
            var names = new[] { "command", "icon", "displayName", "appId" };
            for (uint id = 2; id <= 5; id++)
            {
                var key = new PropertyKey(id);
                PropVariant value;
                Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
                try
                {
                    if (value.Type != 31)
                        throw new Exception("Missing/non-string HWND property: " + names[id - 2] + " (VT=" + value.Type + ")");
                    result.Add(names[id - 2], Marshal.PtrToStringUni(value.Value));
                }
                finally { PropVariantClear(ref value); }
            }
            return result;
        }
        finally { Marshal.ReleaseComObject(store); }
    }

    public static string[] ParseCommand(string command)
    {
        int count;
        var argv = CommandLineToArgvW(command, out count);
        if (argv == IntPtr.Zero) throw new Exception("CommandLineToArgvW failed");
        try
        {
            var result = new string[count];
            for (int i = 0; i < count; i++)
                result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
            return result;
        }
        finally { LocalFree(argv); }
    }

    static byte[] RenderIcon(IntPtr icon, int width, int height, byte background)
    {
        var dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) throw new Exception("CreateCompatibleDC failed");
        IntPtr bitmap = IntPtr.Zero, previous = IntPtr.Zero;
        try
        {
            var info = new BitmapInfo {
                Size = 40, Width = width, Height = -height, Planes = 1, BitCount = 32
            };
            IntPtr bits;
            bitmap = CreateDIBSection(dc, ref info, 0, out bits, IntPtr.Zero, 0);
            if (bitmap == IntPtr.Zero) throw new Exception("CreateDIBSection failed");
            previous = SelectObject(dc, bitmap);
            var pixels = new byte[width * height * 4];
            for (int i = 0; i < pixels.Length; i += 4)
            {
                pixels[i] = pixels[i + 1] = pixels[i + 2] = background;
                pixels[i + 3] = 255;
            }
            Marshal.Copy(pixels, 0, bits, pixels.Length);
            if (!DrawIconEx(dc, 0, 0, icon, width, height, 0, IntPtr.Zero, 3))
                throw new Exception("DrawIconEx failed");
            GdiFlush();
            Marshal.Copy(bits, pixels, 0, pixels.Length);
            return pixels;
        }
        finally
        {
            if (previous != IntPtr.Zero) SelectObject(dc, previous);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            DeleteDC(dc);
        }
    }

    static void CheckSize(IntPtr icon, int width, int height, string label)
    {
        IconInfo info;
        if (!GetIconInfo(icon, out info)) throw new Exception(label + ": GetIconInfo failed");
        try
        {
            Bitmap bitmap;
            if (info.Color == IntPtr.Zero ||
                GetObject(info.Color, Marshal.SizeOf(typeof(Bitmap)), out bitmap) == 0)
                throw new Exception(label + ": missing color bitmap");
            if (bitmap.Width != width || Math.Abs(bitmap.Height) != height)
                throw new Exception(label + ": wrong native icon size " + bitmap.Width + "x" + bitmap.Height +
                    ", expected " + width + "x" + height);
        }
        finally
        {
            if (info.Color != IntPtr.Zero) DeleteObject(info.Color);
            if (info.Mask != IntPtr.Zero) DeleteObject(info.Mask);
        }
    }

    public static string CheckIcons(IntPtr window, string sourceIcon)
    {
        var sizes = new List<string>();
        for (uint kind = 0; kind <= 1; kind++)
        {
            var label = kind == 0 ? "small" : "big";
            int width = GetSystemMetrics(kind == 0 ? 49 : 11);
            int height = GetSystemMetrics(kind == 0 ? 50 : 12);
            UIntPtr iconValue;
            if (SendMessageTimeout(window, 0x007F, new UIntPtr(kind), IntPtr.Zero, 2, 2000, out iconValue) == IntPtr.Zero ||
                iconValue == UIntPtr.Zero)
                throw new Exception(label + ": HWND has no WM_GETICON value");
            var actual = new IntPtr(unchecked((long)iconValue.ToUInt64()));
            CheckSize(actual, width, height, label);
            var expected = LoadImage(IntPtr.Zero, sourceIcon, 1, width, height, 0x10);
            if (expected == IntPtr.Zero) throw new Exception("Cannot load reference ICO: " + sourceIcon);
            try
            {
                foreach (byte background in new byte[] { 0, 255 })
                {
                    var actualPixels = RenderIcon(actual, width, height, background);
                    var expectedPixels = RenderIcon(expected, width, height, background);
                    for (int i = 0; i < actualPixels.Length; i++)
                        if (actualPixels[i] != expectedPixels[i])
                            throw new Exception(label + ": native window icon pixels differ from DK ICO");
                }
            }
            finally { DestroyIcon(expected); } // The HWND owns actual; never destroy it.
            sizes.Add(label + "=" + width + "x" + height);
        }
        return String.Join(", ", sizes);
    }

    public static void CloseWindow(IntPtr window)
    {
        PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}
