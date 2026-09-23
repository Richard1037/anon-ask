# 防待机守护（安全版：只在插电时生效）
#
# 原理：调用 kernel32 的 SetThreadExecutionState，向系统声明「我需要保持运行」。
# 这个 API 是按线程生效的，所以脚本必须一直活着 —— 它每 15 秒检查并重申一次。
#
# ⚠️ 为什么必须「只在插电时生效」：
#   Modern Standby（S0 低功耗待机）的设计目的，就是让你可以合盖把笔记本放进包里。
#   如果无条件阻止待机，合盖 + 放进密闭电脑包 = 一台全速运行的电脑塞在保温袋里，
#   热量散不出去，会降频、强制关机，更现实的是**热坏电池**（锂电池高温加速老化/鼓包）。
#   所以：一旦检测到拔掉电源，立刻释放这个请求，让系统能正常休眠。
#
# 能解决：插电时闲置导致的睡眠 / Modern Standby 挂起。
# 不解决：合盖待机（那是系统强制行为）、关机、注销、电池耗尽。
#
# PowerShell 5.1 读 .ps1 默认按 ANSI 解码，所以本文件必须带 UTF-8 BOM，
# 否则中文会乱码。改动本文件时请保留 BOM。

$ErrorActionPreference = 'Stop'

# 注意：不要加 -UsingNamespace System.Runtime.InteropServices ——
# Add-Type -MemberDefinition 已经内置了这条 using，重复会被当作编译错误
# （"using 指令以前在此命名空间中出现过"）。
Add-Type -Namespace AnonAsk -Name Power -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);

[StructLayout(LayoutKind.Sequential)]
public struct SYSTEM_POWER_STATUS {
    public byte ACLineStatus;
    public byte BatteryFlag;
    public byte BatteryLifePercent;
    public byte SystemStatusFlag;
    public uint BatteryLifeTime;
    public uint BatteryFullLifeTime;
}

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);
'@

# 常量必须用十进制字面量：0x80000000 在 PowerShell 里会溢出成负数导致转换失败
$ES_CONTINUOUS      = [uint32]2147483648   # 0x80000000 保持状态直到再次调用
$ES_SYSTEM_REQUIRED = [uint32]1            # 0x00000001 阻止系统进入睡眠
$ES_AWAYMODE        = [uint32]64           # 0x00000040 离开模式

$holdFlags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE
$releaseFlags = $ES_CONTINUOUS              # 只保留 CONTINUOUS = 撤销「保持运行」的请求

function Get-PowerState {
    $st = New-Object AnonAsk.Power+SYSTEM_POWER_STATUS
    if (-not [AnonAsk.Power]::GetSystemPowerStatus([ref]$st)) {
        return @{ Known = $false; OnAc = $true; Percent = -1 }
    }
    # BatteryFlag 第 7 位（128）表示「没有电池」= 台式机，当作一直插电
    $noBattery = ($st.BatteryFlag -band 128) -ne 0
    $onAc = $noBattery -or ($st.ACLineStatus -eq 1)
    $percent = if ($st.BatteryLifePercent -le 100) { [int]$st.BatteryLifePercent } else { -1 }
    return @{ Known = $true; OnAc = $onAc; Percent = $percent }
}

Write-Host ''
Write-Host '  防待机守护（安全版）已启动，无需管理员权限'
Write-Host ''
Write-Host '  · 插电时 -> 保持运行，网站不会因为闲置而断'
Write-Host '  · 拔电后 -> 立即释放，系统可以正常休眠（合盖进包是安全的）'
Write-Host ''
Write-Host '  关闭这个窗口或结束 powershell 进程即可停止'
Write-Host ''

$holding = $false

while ($true) {
    $p = Get-PowerState

    if (-not $p.Known) {
        # 读不到电源状态时保守处理：不阻止待机（宁可网站断，也不要过热）
        if ($holding) {
            [AnonAsk.Power]::SetThreadExecutionState($releaseFlags) | Out-Null
            $holding = $false
            Write-Host "  [$(Get-Date -Format 'HH:mm:ss')] 读不到电源状态 -> 已释放防待机（保守处理）"
        }
    }
    elseif ($p.OnAc) {
        $prev = [AnonAsk.Power]::SetThreadExecutionState($holdFlags)
        if ($prev -eq 0) {
            Write-Host "  [$(Get-Date -Format 'HH:mm:ss')] [警告] 请求失败，错误码 $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        if (-not $holding) {
            $holding = $true
            Write-Host "  [$(Get-Date -Format 'HH:mm:ss')] 已插电 -> 开启防待机，网站保持在线"
        }
    }
    else {
        if ($holding) {
            [AnonAsk.Power]::SetThreadExecutionState($releaseFlags) | Out-Null
            $holding = $false
            $pct = if ($p.Percent -ge 0) { "，电量 $($p.Percent)%" } else { '' }
            Write-Host "  [$(Get-Date -Format 'HH:mm:ss')] 已断电$pct -> 关闭防待机，可以安全合盖放进包里了"
        }
    }

    Start-Sleep -Seconds 15
}
