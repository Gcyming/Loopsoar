// Loopsoar 进程树守护（Windows Job Object）。
//
// 为什么需要：Electron 主进程被强杀/崩溃时，它派生的终端、MCP、扩展 worker、后台构建
// 不会自动退出（Node 没有父进程死亡通知）。Windows 的 Job Object 提供内核级保证：
// 把主进程放进一个 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 的作业后，作业里所有进程（含之后
// 派生的子孙进程）会在作业句柄关闭时被内核一起结束。
//
// 设计：
//   · 本程序由主进程以 detached 方式启动，参数是主进程 PID；
//   · 创建 Job、设置 kill-on-close、把主进程 Assign 进 Job，然后等待主进程退出；
//   · 主进程退出（正常/崩溃/被强杀）→ 等待返回 → 进程退出 → Job 句柄关闭 → 内核杀掉所有成员。
//   · 不继承句柄（默认），因此 Job 的生命周期严格由本守护进程决定。
//
// 构建：scripts/build-job-guard.mjs（用系统自带 csc.exe 编译，不需要 MSVC）。
using System;
using System.Runtime.InteropServices;

internal static class JobGuard
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint INFINITE = 0xFFFFFFFF;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private static void Fail(string step, int code)
    {
        Console.Error.WriteLine("jobGuard: " + step + " failed, win32=" + Marshal.GetLastWin32Error() + ", exit=" + code);
    }

    private static int Main(string[] args)
    {
        if (args.Length >= 1 && args[0] == "--whoami")
        {
            Console.Error.WriteLine("user=" + System.Security.Principal.WindowsIdentity.GetCurrent().Name);
            Console.Error.WriteLine("token=" + System.Security.Principal.WindowsIdentity.GetCurrent().Token);
            return 0;
        }

        if (args.Length >= 2 && args[0] == "--probe")
        {
            int probePid;
            if (!int.TryParse(args[1], out probePid)) return 1;
            foreach (uint mask in new uint[] { 0x100000, 0x100001, 0x100101, 0x1F0FFF })
            {
                IntPtr h = OpenProcess(mask, false, probePid);
                Console.Error.WriteLine("probe mask=0x" + mask.ToString("X") + " handle=" + h + " err=" + Marshal.GetLastWin32Error());
                if (h != IntPtr.Zero) CloseHandle(h);
            }
            return 0;
        }

        int pid;
        if (args.Length < 1 || !int.TryParse(args[0], out pid) || pid <= 0) return 1;

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) { Fail("CreateJobObject", 2); return 2; }

        var info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
            {
                CloseHandle(job);
                Fail("SetInformationJobObject", 3);
                return 3;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | SYNCHRONIZE, false, pid);
        if (process == IntPtr.Zero)
        {
            Fail("OpenProcess(" + pid + ")", 4);
            CloseHandle(job);
            return 4;
        }

        // 进程可能已经在别的作业里：Win8+ 支持嵌套作业，失败时直接退出，
        // 由调用方按「没有守护」降级（不影响应用启动）。
        if (!AssignProcessToJobObject(job, process))
        {
            Fail("AssignProcessToJobObject(" + pid + ")", 5);
            CloseHandle(process);
            CloseHandle(job);
            return 5;
        }

        WaitForSingleObject(process, INFINITE);
        CloseHandle(process);
        // main 返回 → 进程退出 → job 句柄关闭 → 内核结束作业内所有剩余进程。
        return 0;
    }
}
