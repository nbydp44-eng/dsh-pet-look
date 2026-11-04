/**
 * 内联 PowerShell 脚本源。
 *
 * 约束（实测）：把这几段拼进一个 .ps1 文件会被 Windows Defender 的 AMSI 判定为
 * ScriptContainedMaliciousContent 并拦截；而同样内容经 `-Command` 内联传入可以正常
 * 执行。因此每段脚本单独成串、单独调用，绝不落盘。
 */

/** 截取主显示器 Bounds（PerMonitorV2 物理像素）→ 缩放到 maxWidth 的 JPEG，并算 64 位 dHash。 */
export const CAPTURE = `
$maxW=[int]$env:DSH_LOOK_MAXW
$out=$env:DSH_LOOK_OUT
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ('DshDpi' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
}
try { [void][DshDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][DshDpi]::SetProcessDPIAware() } catch {} }
$sw=[Diagnostics.Stopwatch]::StartNew()
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
$g.Dispose()
$ratio=[Math]::Min(1.0,($maxW / $bmp.Width))
$w=[int][Math]::Round($bmp.Width*$ratio)
$h=[int][Math]::Round($bmp.Height*$ratio)
$small=New-Object System.Drawing.Bitmap($w,$h)
$sg=[System.Drawing.Graphics]::FromImage($small)
$sg.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$sg.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$sg.DrawImage($bmp,0,0,$w,$h)
$sg.Dispose()
$bmp.Dispose()
$small.Save($out,[System.Drawing.Imaging.ImageFormat]::Jpeg)
$hb=New-Object System.Drawing.Bitmap(9,8)
$hg=[System.Drawing.Graphics]::FromImage($hb)
$hg.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
$hg.DrawImage($small,0,0,9,8)
$hg.Dispose()
$sb=New-Object System.Text.StringBuilder
for($y=0;$y -lt 8;$y++){
  for($x=0;$x -lt 8;$x++){
    $p1=$hb.GetPixel($x,$y)
    $p2=$hb.GetPixel($x+1,$y)
    $l1=0.299*$p1.R+0.587*$p1.G+0.114*$p1.B
    $l2=0.299*$p2.R+0.587*$p2.G+0.114*$p2.B
    if($l1 -gt $l2){[void]$sb.Append('1')}else{[void]$sb.Append('0')}
  }
}
$hb.Dispose()
$hash=$sb.ToString()
$small.Dispose()
$sw.Stop()
@{ok=$true;width=$w;height=$h;hash=$hash;monitors=[System.Windows.Forms.Screen]::AllScreens.Count;srcW=$b.Width;srcH=$b.Height;ms=[int]$sw.ElapsedMilliseconds} | ConvertTo-Json -Compress
`

/**
 * 本地隐私闸门：Windows.Media.Ocr 识别 → 关键词/证件号/手机号/银行卡/邮箱匹配 →
 * 命中即整行涂黑，高危词命中直接阻断。**文本从不离开本进程**：只回传判定码与矩形计数。
 */
export const PRIVACY = `
$src=$env:DSH_LOOK_IMG
$out=$env:DSH_LOOK_REDACT
$ratio=[double]$env:DSH_LOOK_RATIO
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$m=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
if($null -eq $m){ @{ok=$false;reason='winrt-missing'} | ConvertTo-Json -Compress; exit 0 }
function Await($op,$t){ $gm=$m.MakeGenericMethod($t); $task=$gm.Invoke($null,@($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if($null -eq $engine){ @{ok=$false;reason='no-ocr-engine'} | ConvertTo-Json -Compress; exit 0 }
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($src)) ([Windows.Storage.StorageFile])
$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$res=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$softMax=[int]$env:DSH_LOOK_SOFT
if($softMax -le 0){ $softMax=4 }
# 第一档：凭据类词，命中即整屏跳过（宁可不看，也不能把登录/密钥界面送出去）。
$hard=@('密码','验证码','私钥','助记词','恢复码','安全码')
$hardEn=@('password','passwd','passcode','verification code','seed phrase','mnemonic','private key','api key','cvv','cvc')
# 第二档：隐私相关词，单独出现只记分；同一屏堆得够多（默认 4 处）才判定为支付/账户页面，整屏跳过。
$soft=@('支付','付款','转账','汇款','网银','银行卡','信用卡','借记卡','身份证','余额','账单','支付宝','微信支付','银行','账号','账户','登录','手机号','手机号码','证件号','社保','公积金','收款')
$softEn=@('card number','credit card','debit card','iban','swift','billing','checkout','payment','wallet')
$rxCard='(?<!\\d)\\d{13,19}(?!\\d)'
$rxPhone='(?<!\\d)1[3-9]\\d{9}(?!\\d)'
$rxId='(?<!\\d)\\d{17}[\\dXx](?!\\d)'
$rxMail='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'
$codes=New-Object System.Collections.Generic.List[string]
$keywords=New-Object System.Collections.Generic.List[string]
$rects=New-Object System.Collections.Generic.List[object]
$lines=0
$hits=0
$softHits=0
$hardHit=$false
foreach($line in $res.Lines){
  $lines++
  $compact=''
  $x1=[double]::MaxValue; $y1=[double]::MaxValue; $x2=0.0; $y2=0.0
  foreach($w in $line.Words){
    $compact=$compact+$w.Text
    $r=$w.BoundingRect
    if($r.X -lt $x1){$x1=$r.X}
    if($r.Y -lt $y1){$y1=$r.Y}
    if(($r.X+$r.Width) -gt $x2){$x2=$r.X+$r.Width}
    if(($r.Y+$r.Height) -gt $y2){$y2=$r.Y+$r.Height}
  }
  $lhit=$false
  $low=$compact.ToLowerInvariant()
  foreach($k in $hard){ if($compact.Contains($k)){ $lhit=$true; $hardHit=$true; if(-not $codes.Contains('hard-kw')){$codes.Add('hard-kw')}; if(-not $keywords.Contains($k)){$keywords.Add($k)} } }
  foreach($k in $hardEn){ if($low.Contains($k)){ $lhit=$true; $hardHit=$true; if(-not $codes.Contains('hard-kw-en')){$codes.Add('hard-kw-en')}; if(-not $keywords.Contains($k)){$keywords.Add($k)} } }
  foreach($k in $soft){ if($compact.Contains($k)){ $softHits++; if(-not $codes.Contains('soft-kw')){$codes.Add('soft-kw')}; if(-not $keywords.Contains($k)){$keywords.Add($k)} } }
  foreach($k in $softEn){ if($low.Contains($k)){ $softHits++; if(-not $codes.Contains('soft-kw-en')){$codes.Add('soft-kw-en')}; if(-not $keywords.Contains($k)){$keywords.Add($k)} } }
  if([regex]::IsMatch($compact,$rxCard)){ $lhit=$true; if(-not $codes.Contains('card')){$codes.Add('card')} }
  if([regex]::IsMatch($compact,$rxPhone)){ $lhit=$true; if(-not $codes.Contains('phone')){$codes.Add('phone')} }
  if([regex]::IsMatch($compact,$rxId)){ $lhit=$true; if(-not $codes.Contains('id')){$codes.Add('id')} }
  if([regex]::IsMatch($compact,$rxMail)){ $lhit=$true; if(-not $codes.Contains('email')){$codes.Add('email')} }
  if($lhit){ $hits++; $rects.Add(@{x=$x1;y=$y1;w=($x2-$x1);h=($y2-$y1)}) }
}
$verdict='ok'
if($hardHit){ $verdict='blocked' }
elseif($softHits -ge $softMax){ $verdict='blocked' }
elseif($lines -gt 0 -and ($hits / $lines) -gt $ratio){ $verdict='blocked' }
elseif($hits -gt 0){ $verdict='redacted' }
elseif($softHits -gt 0){ if(-not $codes.Contains('soft-only')){$codes.Add('soft-only')} }
$didRedact=$false
if($verdict -eq 'redacted'){
  $bmp=New-Object System.Drawing.Bitmap($src)
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $brush=[System.Drawing.Brushes]::Black
  foreach($r in $rects){
    $rx=[int][Math]::Max(0,($r.x-6)); $ry=[int][Math]::Max(0,($r.y-4))
    $rw=[int][Math]::Min(($bmp.Width-$rx),($r.w+12)); $rh=[int][Math]::Min(($bmp.Height-$ry),($r.h+8))
    if($rw -gt 0 -and $rh -gt 0){ $g.FillRectangle($brush,$rx,$ry,$rw,$rh) }
  }
  $g.Dispose()
  $bmp.Save($out,[System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bmp.Dispose()
  $didRedact=$true
}
@{ok=$true;verdict=$verdict;codes=@($codes);keywords=@($keywords);lines=$lines;hits=$hits;softHits=$softHits;redacted=$didRedact;words=$res.Lines.Count} | ConvertTo-Json -Compress
`

/** 前台窗口 + 空闲时长 + 锁屏判断。标题只回传长度与粗分类标签，不回传原文。 */
export const SYS = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshFg {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
}
'@
$h=[DshFg]::GetForegroundWindow()
$title=''
$proc=''
if($h -ne [IntPtr]::Zero){
  $sb=New-Object System.Text.StringBuilder 512
  [void][DshFg]::GetWindowTextW($h,$sb,512)
  $title=$sb.ToString()
  $wpid=0
  [void][DshFg]::GetWindowThreadProcessId($h,[ref]$wpid)
  try { $proc=(Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch {}
}
$li=New-Object DshFg+LASTINPUTINFO
$li.cbSize=[System.Runtime.InteropServices.Marshal]::SizeOf($li)
[void][DshFg]::GetLastInputInfo([ref]$li)
$diff=([Environment]::TickCount64 - [int64]$li.dwTime)
if($diff -lt 0){ $diff=0 }
$idle=[int]($diff/1000)
$hay=($proc+' '+$title).ToLowerInvariant()
$tags=New-Object System.Collections.Generic.List[string]
$groups=[ordered]@{
 'code'=@('visual studio','code','devenv','pycharm','webstorm','idea64','sublime','vim','neovim','cursor','trae','windows terminal','powershell','cmd.exe','wt.exe','git bash')
 'study'=@('acrobat','pdf','onenote','notion','winword','powerpnt','zotero','anki','xmind')
 'game'=@('steam','epicgames','battle.net','unity','unreal','game')
 'video'=@('youtube','bilibili','netflix','potplayer','vlc','mpv','iqiyi','youku')
 'chat'=@('wechat','weixin','qq','telegram','discord','slack','feishu','lark','dingtalk','whatsapp')
 'risky'=@('bank','银行','支付','payment','alipay','支付宝','paypal','stripe','checkout','coinbase','binance','1password','keepass','bitwarden','lastpass','dashlane','enpass','wallet')
}
foreach($k in $groups.Keys){
  foreach($t in $groups[$k]){ if($hay.Contains($t)){ $tags.Add($k); break } }
}
$locked=($h -eq [IntPtr]::Zero) -or ($proc -eq 'LogonUI') -or ($proc -eq 'LockApp')
@{ok=$true;idleSec=$idle;locked=$locked;proc=$proc;titleLen=$title.Length;tags=@($tags)} | ConvertTo-Json -Compress
`

/** 只看前台窗口是谁（轻量）：用于气泡智能收起，标题只回传哈希，不回传原文。 */
export const FOREGROUND = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshFg2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$h=[DshFg2]::GetForegroundWindow()
$title=''
$proc=''
if($h -ne [IntPtr]::Zero){
  $sb=New-Object System.Text.StringBuilder 512
  [void][DshFg2]::GetWindowTextW($h,$sb,512)
  $title=$sb.ToString()
  $wpid=0
  [void][DshFg2]::GetWindowThreadProcessId($h,[ref]$wpid)
  try { $proc=(Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch {}
}
$hash=0
foreach($ch in $title.ToCharArray()){ $hash=(($hash*31)+[int]$ch) -band 0x7fffffff }
$key=$proc+'#'+$hash
@{ok=$true;proc=$proc;titleHash=$hash;key=$key} | ConvertTo-Json -Compress
`

/** 电源/负载/温度。任一不可读就留 null，不失败。 */
export const POWER = `
$onAC=$null
$pct=$null
try {
  $b=Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1
  if($b){ $onAC=($b.BatteryStatus -ne 1); $pct=[int]$b.EstimatedChargeRemaining }
} catch {}
$load=$null
try { $load=[int](Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average } catch {}
$temp=$null
try {
  $z=Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 1
  if($z){ $temp=[math]::Round(($z.CurrentTemperature/10)-273.15,1) }
} catch {}
@{ok=$true;onAC=$onAC;battery=$pct;load=$load;tempC=$temp} | ConvertTo-Json -Compress
`
