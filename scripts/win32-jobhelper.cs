// win32-jobhelper.cs — Win32 Job Object supervision helper for AI-workflow
// (Issue #98 Phase 2; selection ruling candidate C: source in repo, lazily
// compiled by the Windows built-in .NET Framework compiler csc.exe — zero npm
// dependencies, zero install scripts, zero downloads).
//
// CLI:  jobhelper.exe --ppid <parent-pid> --mem-mb <n|0> -- <cmd> <args...>
//
// The helper is the DIRECT parent of the supervised command. It creates a Job
// Object, spawns <cmd> suspended into that job, then waits on BOTH the child
// and the parent:
//   - child exits first  -> its exit code is forwarded 1:1 (the job handle
//     closes on helper exit; KILL_ON_JOB_CLOSE sweeps any survivors, so a
//     command that leaves grandchildren behind cannot outlive the helper);
//   - parent dies first  -> TerminateJobObject + exit code 1 (unreachable from
//     node — the parent is dead — this is the crash-insurance branch);
//   - CreateProcessW fails -> sentinel line on stderr + exit code 3;
//   - the child is not in the job after assignment -> sentinel + exit code 2.
//
// Spawn-failure semantics (Issue #98 review round 1, opinion 5): the exit
// codes 2/3 collide with a forwarded child exit code (a real child may exit 2
// or 3 on its own), so the AUTHORITATIVE spawn-failure criterion on the node
// side is the stderr sentinel line, never the exit code. Sentinels are exactly:
//   "aiwf-jobhelper: spawn <cmd> <errno>"       (CreateProcessW failed)
//   "aiwf-jobhelper: spawn <cmd> is-in-job-check-failed"   (exit code 2)
// with the errno mapping: win32 error 2/3 -> ENOENT, 5 -> EACCES, else EUNKNOWN.
//
// ============================================================================
// IRON RULES (do not remove — the node-side lazy compiler compiles this file
// with the Windows built-in csc.exe v4.0.30319, whose banner reads
// "for C# 5"):
//   1. C# 5 SYNTAX ONLY: no string interpolation ($""), no null-conditional
//      (?.), no out var, no nameof, no expression-bodied members. Upgrading
//      the syntax silently breaks every machine whose only compiler is the
//      in-box Framework 4 csc — the node side then permanently degrades to
//      fallback-taskkill (observable via dwf_job_guard, but a regression).
//   2. The job handle AND every non-stdio handle must have the inherit bit
//      cleared (SetHandleInformation) and the child must be created with a
//      PROC_THREAD_ATTRIBUTE_HANDLE_LIST whitelist containing ONLY the three
//      std handles. If the job handle were inherited by the supervised tree,
//      killing the helper would NOT close the last job handle and
//      KILL_ON_JOB_CLOSE would never fire — a silent, error-less failure whose
//      only behavioral gate is the helper-kill isolation test
//      (tests/unit/dwf/process-supervision-jobguard.test.ts case (b2)).
// ============================================================================

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AiWorkflow.JobHelper
{
    internal static class Program
    {
        // ---- kernel32 P/Invoke -------------------------------------------------

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr hJob, int jobObjectInfoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool pbResult);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessW(
            string lpApplicationName, StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
            bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment,
            string lpCurrentDirectory, ref STARTUPINFOEXW lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr lpAttributeList, uint dwFlags, IntPtr lpAttribute, IntPtr lpValue,
            IntPtr cbSize, IntPtr lpPrevValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForMultipleObjects(
            uint nCount, IntPtr[] lpHandles, bool bWaitAll, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        // ---- constants ----------------------------------------------------------

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
        private const int HANDLE_FLAG_INHERIT = 0x00000001;
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        private const uint SYNCHRONIZE = 0x00100000;
        private const uint PROCESS_SET_QUOTA = 0x0100;
        private const uint PROCESS_TERMINATE = 0x0001;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint INFINITE = 0xFFFFFFFF;
        private const string SentinelPrefix = "aiwf-jobhelper: spawn ";

        // ---- structures -----------------------------------------------------------

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFOW
        {
            public uint cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFOEXW
        {
            public STARTUPINFOW StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        // ---- helpers ---------------------------------------------------------------

        private static bool IsValidHandle(IntPtr h)
        {
            return h != IntPtr.Zero && h != new IntPtr(-1);
        }

        private static void WriteSentinel(string cmd, string reason)
        {
            // UTF-8 without BOM on the redirected stderr pipe — node reads utf8.
            try
            {
                using (var writer = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
                {
                    writer.AutoFlush = true;
                    writer.WriteLine(SentinelPrefix + cmd + " " + reason);
                }
            }
            catch (ObjectDisposedException)
            {
                // stderr already closed — nothing to report to.
            }
            catch (IOException)
            {
                // broken pipe — nothing to report to.
            }
        }

        private static string MapErrno(int win32Error)
        {
            if (win32Error == 2 || win32Error == 3) return "ENOENT";
            if (win32Error == 5) return "EACCES";
            return "EUNKNOWN";
        }

        /// Standard MSVCRT argument quoting (round-trips node's argv parsing).
        private static string QuoteArg(string arg)
        {
            if (arg.Length > 0 && arg.IndexOf(' ') < 0 && arg.IndexOf('\t') < 0 && arg.IndexOf('"') < 0)
            {
                return arg;
            }
            var sb = new StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                }
                else if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                    backslashes = 0;
                }
                else
                {
                    if (backslashes > 0)
                    {
                        sb.Append('\\', backslashes);
                        backslashes = 0;
                    }
                    sb.Append(c);
                }
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        // ---- main -------------------------------------------------------------------

        private static int Main(string[] args)
        {
            // Issue #117 adopt mode: put an EXISTING process (e.g. an MCP stdio
            // server the SDK spawned on our behalf) into a fresh kill-on-close
            // job, then act as its watchdog — when the host pid exits (any way,
            // including SIGKILL of node), this helper exits, the job handle
            // closes, and the kernel tears the child down. Usage:
            //   jobhelper adopt --pid <childPid> --ppid <hostPid>
            if (args.Length > 0 && args[0] == "adopt")
            {
                return AdoptMode(args);
            }
            long ppid = 0;
            long memMb = 0;
            int cmdIndex = -1;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--ppid" && i + 1 < args.Length)
                {
                    long.TryParse(args[i + 1], out ppid);
                    i++;
                }
                else if (args[i] == "--mem-mb" && i + 1 < args.Length)
                {
                    long.TryParse(args[i + 1], out memMb);
                    i++;
                }
                else if (args[i] == "--")
                {
                    cmdIndex = i + 1;
                    break;
                }
            }
            if (cmdIndex < 0 || cmdIndex >= args.Length)
            {
                WriteSentinel("<missing-command>", "EUSAGE");
                return 3;
            }
            string cmd = args[cmdIndex];

            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            if (!IsValidHandle(job))
            {
                WriteSentinel(cmd, "EUNKNOWN");
                return 3;
            }
            // Iron rule 2: the job handle must never be inherited (see file header).
            SetHandleInformation(job, HANDLE_FLAG_INHERIT, 0);

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (memMb > 0)
            {
                long bytes = memMb * 1024L * 1024L;
                bytes = (bytes + 0xFFFFL) & ~0xFFFFL; // 64KB allocation-granularity alignment
                limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                limits.ProcessMemoryLimit = new UIntPtr((ulong)bytes);
            }
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                WriteSentinel(cmd, "job-config-failed");
                CloseHandle(job);
                return 3;
            }

            // std handles: pass the helper's own stdio through to the real child
            // (byte-faithful NDJSON duplex — no buffering, no re-encoding).
            IntPtr stdIn = GetStdHandle(STD_INPUT_HANDLE);
            IntPtr stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
            IntPtr stdErr = GetStdHandle(STD_ERROR_HANDLE);
            IntPtr[] stdHandles = new IntPtr[] { stdIn, stdOut, stdErr };
            var inheritable = new List<IntPtr>();
            foreach (IntPtr h in stdHandles)
            {
                if (IsValidHandle(h))
                {
                    SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                    inheritable.Add(h);
                }
            }

            // Handle whitelist (iron rule 2): ONLY the std handles may cross the
            // inherit boundary — nothing else (least privilege).
            IntPtr attrList = IntPtr.Zero;
            IntPtr attrSize = IntPtr.Zero;
            GCHandle pinnedHandles = default(GCHandle);
            if (inheritable.Count > 0)
            {
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
                if (attrSize != IntPtr.Zero)
                {
                    attrList = Marshal.AllocHGlobal(attrSize);
                    if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize))
                    {
                        Marshal.FreeHGlobal(attrList);
                        attrList = IntPtr.Zero;
                    }
                }
                if (attrList != IntPtr.Zero)
                {
                    IntPtr[] whitelist = inheritable.ToArray();
                    pinnedHandles = GCHandle.Alloc(whitelist, GCHandleType.Pinned);
                    if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                        pinnedHandles.AddrOfPinnedObject(), (IntPtr)(whitelist.Length * IntPtr.Size),
                        IntPtr.Zero, IntPtr.Zero))
                    {
                        DeleteProcThreadAttributeList(attrList);
                        Marshal.FreeHGlobal(attrList);
                        pinnedHandles.Free();
                        attrList = IntPtr.Zero;
                    }
                }
            }

            var si = new STARTUPINFOEXW();
            si.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEXW));
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = stdIn;
            si.StartupInfo.hStdOutput = stdOut;
            si.StartupInfo.hStdError = stdErr;
            si.lpAttributeList = attrList;

            var commandLine = new StringBuilder();
            commandLine.Append(QuoteArg(cmd));
            for (int i = cmdIndex + 1; i < args.Length; i++)
            {
                commandLine.Append(' ');
                commandLine.Append(QuoteArg(args[i]));
            }

            PROCESS_INFORMATION pi;
            uint creationFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW;
            bool created = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                creationFlags, IntPtr.Zero, null, ref si, out pi);
            int createError = Marshal.GetLastWin32Error();

            if (pinnedHandles.IsAllocated) pinnedHandles.Free();
            if (attrList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attrList);
                Marshal.FreeHGlobal(attrList);
            }

            if (!created)
            {
                WriteSentinel(cmd, MapErrno(createError));
                CloseHandle(job);
                return 3;
            }

            // The assignment result is not judged on its own: the IsProcessInJob
            // check below is the authoritative verdict (covers nested-job edge cases).
            AssignProcessToJobObject(job, pi.hProcess);

            bool inJob = false;
            if (!IsProcessInJob(pi.hProcess, job, out inJob) || !inJob)
            {
                WriteSentinel(cmd, "is-in-job-check-failed");
                TerminateJobObject(job, 2);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(job);
                return 2;
            }

            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);

            // Crash insurance: wait on the caller too — if the node parent dies the
            // whole supervised tree must not survive it.
            IntPtr parent = IntPtr.Zero;
            if (ppid > 0)
            {
                parent = OpenProcess(SYNCHRONIZE, false, (uint)ppid);
            }

            uint childExit;
            if (IsValidHandle(parent))
            {
                IntPtr[] waits = new IntPtr[] { pi.hProcess, parent };
                uint wait = WaitForMultipleObjects(2, waits, false, INFINITE);
                if (wait == WAIT_OBJECT_0 + 1)
                {
                    // Parent died first: kernel-kill the tree, exit (code 1 is
                    // unreachable from node — nobody is left to read it).
                    TerminateJobObject(job, 1);
                    CloseHandle(pi.hProcess);
                    CloseHandle(parent);
                    CloseHandle(job);
                    return 1;
                }
            }
            else
            {
                WaitForMultipleObjects(1, new IntPtr[] { pi.hProcess }, false, INFINITE);
            }

            // Child exited first: forward its exit code 1:1. Closing the job handle
            // on helper exit sweeps any surviving grandchildren (KILL_ON_JOB_CLOSE).
            uint exitCode = 1;
            if (!GetExitCodeProcess(pi.hProcess, out exitCode)) exitCode = 1;
            CloseHandle(pi.hProcess);
            if (IsValidHandle(parent)) CloseHandle(parent);
            CloseHandle(job);
            return unchecked((int)exitCode);
        }

        /// <summary>
        /// Issue #117 adopt mode (watchdog form): watch an ALREADY-RUNNING pid
        /// on behalf of a host pid — when the host exits (any way, including
        /// SIGKILL of node), TerminateProcess the child. Deliberately NO job
        /// object: assigning an SDK-spawned child into a nested kill-on-close
        /// job collides with the child's own lifetime management (issue #120 B
        /// bisect). The helper is a plain process waiting on two handles.
        /// </summary>
        private static int AdoptMode(string[] args)
        {
            long childPid = 0;
            long hostPid = 0;
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--pid" && i + 1 < args.Length) { long.TryParse(args[i + 1], out childPid); i++; }
                else if (args[i] == "--ppid" && i + 1 < args.Length) { long.TryParse(args[i + 1], out hostPid); i++; }
            }
            if (childPid <= 0)
            {
                WriteSentinel("<adopt>", "EUSAGE");
                return 3;
            }

            IntPtr child = OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, false, (uint)childPid);
            if (!IsValidHandle(child))
            {
                // The child is already gone — nothing to guard; a clean no-op.
                return 0;
            }

            IntPtr parent = IntPtr.Zero;
            if (hostPid > 0)
            {
                parent = OpenProcess(SYNCHRONIZE, false, (uint)hostPid);
            }

            if (IsValidHandle(parent))
            {
                IntPtr[] waits = new IntPtr[] { child, parent };
                uint wait = WaitForMultipleObjects(2, waits, false, INFINITE);
                if (wait == WAIT_OBJECT_0 + 1)
                {
                    // Host died first: terminate the adopted child, exit.
                    TerminateProcess(child, 1);
                    CloseHandle(child);
                    CloseHandle(parent);
                    return 1;
                }
            }
            else
            {
                // The host was already gone when we adopted (helper startup
                // raced the host's death): adopt semantics = reap immediately.
                TerminateProcess(child, 1);
                CloseHandle(child);
                return 1;
            }

            // Child exited on its own (normal client close): exit.
            CloseHandle(child);
            if (IsValidHandle(parent)) CloseHandle(parent);
            return 0;
        }
    }
}
