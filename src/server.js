'use strict';

/**
 * Application entry point.
 *
 *   node src/server.js            start on http://127.0.0.1:8798
 *   PE_PORT=9000 node src/server.js
 *
 * Environment:
 *   PE_HOST               bind address (default 127.0.0.1; 0.0.0.0 to publish on a LAN)
 *   PE_PORT               listen port (default 8798)
 *   PE_DATA_DIR           directory for the database and the audit chain key
 *   PE_SIG_2FA=0          disable the second factor for e-signatures (not recommended)
 *   PE_OPEN_BROWSER=1     open the workbench window after start
 */

const config = require('./config');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./core/db');
const audit = require('./core/audit');
const accounts = require('./domain/accounts');
const seed = require('./seed');
const bootstrap = require('./bootstrap');
const server = require('./api/server');

/**
 * Console banner (utf-8; Chinese-first). start.bat is pure ASCII and runs
 * chcp 65001 before invoking Node, which is why the batch files contain no
 * Chinese of their own.
 */
function banner(url, chain, seeded, accountSummary, monitorRunning) {
  const lines = [
    '',
    '  ============================================================',
    `   药物经济学工作台 · PE-Workbench  v${config.app.version}`,
    '   Pharmacoeconomics Workbench',
    '  ============================================================',
    '',
    `   访问地址 / URL      ${url}`,
    `   数据文件 / Data     ${config.dbFile}`,
    `   Node 版本           ${process.version}`,
    '',
    `   审计追踪 / Audit    ${chain.ok ? `完整 ✓ 已校验 ${chain.checked} 条` : '*** 完整性校验失败 ***'}`,
    `   配置库   / Config   ${seeded.processTypes} 类工作流, ${seeded.checklistTemplates} 张检查表`,
    `   后台进程 / Monitor  ${monitorRunning ? '运行中（定时扫描超期并升级）' : '未启用'}`,
    '',
  ];
  if (accountSummary.enabled) {
    lines.push(
      '   ------------------------------------------------------------',
      `   演示身份 / Demo personas  ${accounts.PERSONAS.length} 个，统一密码 / one password:`,
      `                             ${accounts.BUILTIN_PASSWORD}`,
      '',
      '   打开后先选身份，输入密码进入专属界面。',
      '   Open the app, pick an identity, type the password.',
      '',
      '   ⚠  这是演示配置：账号与密码是公开的，请勿用于真实分析记录。',
      '      如需关闭：设置 PE_BUILTIN_ACCOUNTS=0 后重启。',
      '      Demo configuration: credentials are public. Unset',
      '      PE_BUILTIN_ACCOUNTS to disable before holding real records.',
      ''
    );
  } else {
    lines.push(
      '   ------------------------------------------------------------',
      '   首次使用请在浏览器中创建第一个管理员账号。',
      '   On first use, create the first administrator account in the browser.',
      '',
      '   如需开箱即用的多角色演示账号：',
      '     set PE_BUILTIN_ACCOUNTS=1 && start.bat',
      ''
    );
  }
  lines.push(
    '   数据目录包含数据库与审计链密钥，请整体定期备份。',
    '   Back up the whole data folder; a backup without audit-chain.key',
    '   cannot verify the audit trail, and that cannot be repaired.',
    '',
    '   关闭本窗口即停止服务。 / Closing this window stops the service.',
    '   ------------------------------------------------------------',
    '',
    config.http.host === '127.0.0.1'
      ? '   仅监听本机 / localhost only. 局域网共享请设 PE_HOST=0.0.0.0。'
      : `   已发布在 ${config.http.host} / published - 共享使用请在前端配置 HTTPS。`,
    '',
    '   Ctrl+C 停止 / press Ctrl+C to stop.',
    ''
  );
  return lines.join('\n');
}

/**
 * Open the workbench in its own Edge --app window rather than a browser tab.
 * Falls back to the default browser only when Edge cannot be found.
 */
function openAppWindow(url) {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');

  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData\\Local');

  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const edge = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

  let args;
  if (edge) {
    const profile = path.join(local, 'PE-Workbench', 'edge-profile');
    try { fs.mkdirSync(profile, { recursive: true }); } catch { /* best effort */ }
    args = [
      '--app=' + url,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,msEdgeTranslate',
    ];
  } else {
    process.stdout.write('  [browser] Edge not found; opening the default browser instead.\n');
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
    return;
  }

  try {
    spawn(edge, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
  }
}

async function main() {
  // Never let an unhandled rejection silently take the process down: log it so
  // the cause is visible in the console instead of a bare exit code 1.
  process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.stack ? reason.stack.split('\n').slice(0, 6).join(' | ') : String(reason);
    process.stderr.write(`  [unhandledRejection] ${msg}\n`);
  });

  db.open();

  let seeded;
  try {
    seeded = seed.run({ silent: true });
  } catch (err) {
    console.error('\n  [错误] 配置库加载失败 / Failed to load the configuration library:');
    console.error(`  ${err.message}`);
    console.error('\n  请检查 seed/workflows 与 seed/checklists 下的 JSON 文件。');
    console.error('  Check the JSON files under seed/workflows and seed/checklists.\n');
    process.exit(1);
  }

  const chain = audit.verifyChain();
  if (!chain.ok && config.features.freezeOnChainBreak) {
    console.error('\n  ************************************************************');
    console.error('  ***  审计追踪完整性校验失败  AUDIT TRAIL INTEGRITY FAILURE  ***');
    console.error('  ************************************************************\n');
    console.error(`  断点 / broken at sequence: ${chain.brokenAt}`);
    console.error(`  原因 / reason: ${chain.reason}\n`);
    console.error('  请按数据完整性事件处理，不要继续使用本系统：');
    console.error('    1. 立即停止操作本系统，不要反复重启；');
    console.error('    2. 原样保全 data 目录（含 pe.db 与 audit-chain.key），不要修改；');
    console.error('    3. 不要尝试重建或修复哈希链；');
    console.error('    4. 通知系统负责人并开具数据完整性问题记录（DISS）。\n');
    console.error('  Treat this as a data integrity incident: stop, preserve the data folder');
    console.error('  untouched, do not attempt to rebuild the chain, and notify the system owner.\n');
    console.error('  To start anyway for investigation only, set PE_FREEZE_ON_CHAIN_BREAK=0.\n');
    process.exit(2);
  }

  let httpServer;
  try {
    httpServer = await server.start();
  } catch (err) {
    console.error(`\n  [错误] 服务启动失败 / Failed to start: ${err.message}\n`);
    process.exit(1);
  }

  // ------------------------------------------------- built-in demo accounts --
  let accountSummary = { enabled: false, created: 0, refreshed: 0 };
  try {
    accountSummary = accounts.provision(
      db.get("SELECT * FROM users WHERE role = 'system_admin' AND status = 'active' ORDER BY id LIMIT 1"),
      { ip: '127.0.0.1', userAgent: 'server-startup', sessionId: null }
    );
  } catch (err) {
    console.error(`  [builtin-accounts] provisioning failed: ${err.message}`);
  }

  // ------------------------------------------------- demonstration dataset --
  let demo = { ran: false, reason: 'skipped' };
  if (config.features.autoSeedDemo) {
    const startedAt = Date.now();
    try {
      demo = await bootstrap.ensureDemoData();
    } catch (err) {
      demo = { ran: false, reason: err.message };
    }
    if (demo.ran) {
      const after = audit.verifyChain();
      demo.chainOk = after.ok;
      demo.entries = after.checked;
      demo.seconds = (Date.now() - startedAt) / 1000;
    }
  } else if (!bootstrap.hasQualityRecords() && accountSummary.enabled) {
    demo = { ran: false, reason: 'automatic seeding is switched off' };
  }

  server.markReady();

  // ------------------------------------------------------ background monitor --
  let monitorProcess = null;
  if (config.features.backgroundMonitor && process.env.PE_NO_MONITOR !== '1') {
    try {
      const { spawn } = require('node:child_process');
      monitorProcess = spawn(
        process.execPath,
        [require('node:path').join(__dirname, 'daemon', 'monitor.js'),
          '--interval', String(process.env.PE_MONITOR_INTERVAL || 300)],
        {
          cwd: config.root,
          env: process.env,
          stdio: ['ignore', 'inherit', 'inherit'],
          windowsHide: true,
        }
      );
      monitorProcess.on('exit', (code, signal) => {
        if (code !== 0 && signal !== 'SIGTERM') {
          process.stderr.write(`  [monitor] exited unexpectedly (code ${code}); workflow deadlines will not be chased.\n`);
        }
      });
      monitorProcess.on('error', (err) => {
        process.stderr.write(`  [monitor] could not start: ${err.message}\n`);
      });
    } catch (err) {
      process.stderr.write(`  [monitor] could not start: ${err.message}\n`);
    }
  }

  const host = config.http.host === '0.0.0.0' ? 'localhost' : config.http.host;
  const url = `http://${host}:${config.http.port}`;
  process.stdout.write(banner(url, chain, seeded, accountSummary, Boolean(monitorProcess)));

  if (accountSummary.enabled && (accountSummary.created || accountSummary.refreshed)) {
    process.stdout.write(`   Built-in personas provisioned: ${accountSummary.created} created, `
      + `${accountSummary.refreshed} refreshed.\n`);
  }
  if (demo.ran) {
    process.stdout.write(`   演示数据   / Demo data  ${demo.records} 条研究记录, ${demo.entries} 条审计记录, `
      + `哈希链校验 ${demo.chainOk ? '通过' : '失败'} (${demo.seconds.toFixed(1)}s)\n`);
  } else if (!bootstrap.hasQualityRecords()) {
    process.stdout.write(`   演示数据   / Demo data  未生成 (${demo.reason}); 可用 scripts/seed-demo.js 手工生成\n`);
  }

  if (process.env.PE_OPEN_BROWSER === '1') {
    openAppWindow(url);
  }

  let shuttingDown = false;
  const stopMonitor = () => {
    if (!monitorProcess || monitorProcess.killed) return;
    try { monitorProcess.kill('SIGTERM'); } catch { /* already gone */ }
  };

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n  ${signal} received, shutting down...\n`);
    stopMonitor();
    httpServer.close(() => {
      try { db.close(); } catch { /* ignore */ }
      process.stdout.write('  Stopped cleanly. Audit trail flushed.\n');
      process.exit(0);
    });
    setTimeout(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    }, 4000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', stopMonitor);

  // --------------------------------------------------- desktop launcher hook --
  // The native desktop window (PEWorkbench.exe) asks the server to stop itself
  // through POST /api/shutdown with a one-time local token, so the exit path is
  // the same graceful one a Ctrl+C would take (monitor stopped, WAL flushed).
  const shutdownApi = require('./api/shutdown');
  shutdownApi.register('desktop-launcher', shutdown);
  const token = require('node:crypto').randomBytes(24).toString('base64url');
  try {
    fs.writeFileSync(path.join(config.dataDir, '.shutdown-token'), token, { mode: 0o600 });
  } catch { /* best effort: shutdown API stays disabled */ }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  Fatal error during start-up:');
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };