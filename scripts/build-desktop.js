'use strict';

/**
 * Build the native desktop launcher: PEWorkbench.exe.
 *
 *   node scripts/build-desktop.js
 *
 * What it does:
 *   1. generates web/favicon.ico from web/favicon.png (window + tray icon);
 *   2. fetches the WebView2 SDK assemblies (Microsoft.Web.WebView2) from
 *      nuget.org into .cache/ when not present - the ONLY network touch, and it
 *      is a build-time step, not a runtime dependency;
 *   3. compiles desktop/PEWorkbench.cs with the C# compiler that ships inside
 *      Windows (.NET Framework), so no Visual Studio / SDK install is needed;
 *   4. emits dist/desktop/PEWorkbench.exe + the three WebView2 DLLs, then copies
 *      them to the project root so a double-click starts the desktop window.
 *
 * Runtime requirements: Windows 10/11 with the WebView2 runtime (ships with
 * Windows updates / Edge) and Node.js 22.5+ for the embedded service.
 */

const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'webview2');
const OUT = path.join(ROOT, 'dist', 'desktop');
const CANDIDATE_VERSIONS = [
  process.env.PE_WV2_VERSION,
  '1.0.4191.47',
  '1.0.2739.15',
  '1.0.1518.46',
  '1.0.1245.22',
].filter(Boolean);

function log(msg) { process.stdout.write('  ' + msg + '\n'); }
function warn(msg) { process.stdout.write('  [warn] ' + msg + '\n'); }

function pickLibDir(pkgDir) {
  for (const lib of ['lib/net45', 'lib/net462', 'lib/net48']) {
    const core = path.join(pkgDir, lib, 'Microsoft.Web.WebView2.Core.dll');
    if (fs.existsSync(core)) return path.join(pkgDir, lib);
  }
  return null;
}

function download(version) {
  const nupkg = path.join(CACHE, `webview2-${version}.nupkg`);
  if (!fs.existsSync(nupkg)) {
    const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${version}/microsoft.web.webview2.${version}.nupkg`;
    log(`downloading ${url}`);
    try {
      const res = spawnSync('powershell', [
        '-NoProfile', '-Command',
        `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ` +
        `(New-Object Net.WebClient).DownloadFile('${url}','${nupkg}')`,
      ], { stdio: 'pipe' });
      if (res.status !== 0 || !fs.existsSync(nupkg)) {
        warn(res.stderr ? res.stderr.toString().slice(0, 300) : `download of ${version} failed`);
        return null;
      }
    } catch (err) {
      warn(`download of ${version} failed: ${err.message}`);
      return null;
    }
  }
  return nupkg;
}

function extract(nupkg) {
  const dest = path.join(CACHE, path.basename(nupkg, '.nupkg'));
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(dest, { recursive: true });
  // tar.exe ships with Windows 10+; fall back to Expand-Archive.
  const tar = 'C:\\Windows\\System32\\tar.exe';
  if (fs.existsSync(tar)) {
    const r = spawnSync(tar, ['-xf', nupkg, '-C', dest], { stdio: 'pipe' });
    if (r.status !== 0) {
      warn('tar extraction failed, trying Expand-Archive');
    } else {
      return dest;
    }
  }
  const r2 = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -Path '${nupkg}' -DestinationPath '${dest}' -Force`,
  ], { stdio: 'pipe' });
  if (r2.status !== 0) { warn('Expand-Archive failed too'); return null; }
  return dest;
}

function resolveSdk() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const version of CANDIDATE_VERSIONS) {
    log(`trying WebView2 SDK ${version}...`);
    const nupkg = download(version);
    if (!nupkg) continue;
    const pkg = extract(nupkg);
    if (!pkg) continue;
    const lib = pickLibDir(pkg);
    if (!lib) { warn(`${version}: no net45/net462 assemblies inside`); continue; }
    const arch = 'x86'; // x86 host matches the Evergreen runtime layout on this machine (x64 host + runtime registered only in the WOW6432Node view triggers RPC_E_CHANGED_MODE / discovery failures)
    const loader = path.join(pkg, 'runtimes', `win-${arch}`, 'native', 'WebView2Loader.dll');
    if (!fs.existsSync(loader)) { warn(`${version}: missing WebView2Loader for ${arch}`); continue; }
    return { version, lib, loader };
  }
  return null;
}

function generateIcon() {
  const png = path.join(ROOT, 'web', 'favicon.png');
  const ico = path.join(ROOT, 'web', 'favicon.ico');
  if (fs.existsSync(ico) && fs.statSync(ico).mtimeMs > fs.statSync(png).mtimeMs) {
    return ico;
  }
  // PowerShell + System.Drawing: PNG -> HICON -> .ico (single 32x32 frame).
  const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${png.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap 32,32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = 'HighQualityBicubic'
$g.DrawImage($src, 0, 0, 32, 32)
$g.Dispose()
$hicon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hicon)
$fs = [System.IO.File]::Create('${ico.replace(/'/g, "''")}')
$icon.Save($fs)
$fs.Close()
$bmp.Dispose(); $src.Dispose()
`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'pipe' });
  if (r.status !== 0 || !fs.existsSync(ico)) {
    warn('could not generate favicon.ico (window icon will fall back to default)');
  }
  return ico;
}

function compile(libDir) {
  const csc = path.join(process.env.windir || 'C:\\Windows', 'Microsoft.NET',
    'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) {
    warn('csc.exe not found; the native launcher cannot be compiled');
    return false;
  }
  const src = path.join(ROOT, 'desktop', 'PEWorkbench.cs');
  // Window chrome - dark title bar, rounded corners, matching border - is the half
  // of the design system that CSS cannot reach, because Windows draws the frame,
  // not the web engine. Byte-identical across LeebertyGXP, LeebertyPV and
  // PE-Workbench, like web/css/design-system.css.
  const windowTheme = path.join(ROOT, 'desktop', 'WindowTheme.cs');
  if (!fs.existsSync(windowTheme)) {
    warn('desktop/WindowTheme.cs not found; the window chrome cannot be themed');
    return false;
  }
  const exe = path.join(OUT, 'PEWorkbench.exe');
  const refs = [
    'System.Drawing.dll', 'System.Windows.Forms.dll',
    path.join(libDir, 'Microsoft.Web.WebView2.Core.dll'),
    path.join(libDir, 'Microsoft.Web.WebView2.WinForms.dll'),
  ];
  const args = [
    '/nologo', '/target:winexe', '/optimize+', '/platform:x86',
    `/out:${exe}`,
    ...refs.map((r) => `/reference:${r}`),
    src,
    windowTheme,
  ];
  log('compiling PEWorkbench.cs ...');
  const r = spawnSync(csc, args, { stdio: 'pipe', cwd: ROOT });
  if (r.status !== 0) {
    process.stderr.write((r.stdout || '').toString() + (r.stderr || '').toString());
    return false;
  }
  return exe;
}

function main() {
  log('PE-Workbench desktop launcher build');
  log('====================================');
  fs.mkdirSync(OUT, { recursive: true });

  const sdk = resolveSdk();
  if (!sdk) {
    process.stderr.write('\n  [error] could not obtain the WebView2 SDK assemblies.\n');
    process.stderr.write('  This step needs network access to nuget.org (build-time only).\n');
    process.exit(1);
  }
  log(`WebView2 SDK ${sdk.version} ready (${path.basename(sdk.lib)})`);

  const ico = generateIcon();
  if (ico) log('favicon.ico ready');

  const exe = compile(sdk.lib);
  if (!exe) {
    process.stderr.write('\n  [error] compilation failed (see messages above).\n');
    process.exit(1);
  }

  // Copy the runtime pieces next to the exe.
  for (const file of [
    path.join(sdk.lib, 'Microsoft.Web.WebView2.Core.dll'),
    path.join(sdk.lib, 'Microsoft.Web.WebView2.WinForms.dll'),
    sdk.loader,
  ]) {
    fs.copyFileSync(file, path.join(OUT, path.basename(file)));
  }
  const rootExe = path.join(ROOT, 'PEWorkbench.exe');
  fs.copyFileSync(exe, rootExe);
  for (const file of [
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
  ]) {
    fs.copyFileSync(path.join(OUT, file), path.join(ROOT, file));
  }

  log('');
  log('built:');
  log(`  ${OUT}\\PEWorkbench.exe   (+ 3 WebView2 DLLs)`);
  log(`  ${ROOT}\\PEWorkbench.exe   (double-click here)`);

  // The window chrome - dark title bar, rounded corners, matching border - is the
  // one part of the design system that no browser suite can reach, because
  // Windows draws the frame rather than the web engine. The freshly built
  // launcher asserts it directly, and needs no server to do so.
  log('');
  log('window chrome self-test:');
  const chrome = spawnSync(exe, ['--selftest'], { encoding: 'utf8', cwd: ROOT });
  process.stdout.write(String(chrome.stdout || ''));
  if (chrome.stderr && chrome.stderr.trim()) process.stderr.write(String(chrome.stderr));
  if (chrome.status !== 0) {
    process.stderr.write('\n  [error] window chrome self-test failed (exit ' + chrome.status + ').\n');
    process.exit(1);
  }

  log('');
  log('Self-test (paints the window to a PNG, then exits):');
  log('  PEWorkbench.exe --shot D:\\window-check.png');
  log('');
}

if (require.main === module) main();