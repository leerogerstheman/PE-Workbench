'use strict';

/**
 * Background workflow monitor.
 *
 *   node src/daemon/monitor.js                 run continuously (default 5 min cycle)
 *   node src/daemon/monitor.js --once          run a single cycle and exit
 *   node src/daemon/monitor.js --interval 900  cycle every 900 seconds
 *   node src/daemon/monitor.js --verbose       print every action taken
 *
 * WHY A SEPARATE PROCESS
 * ----------------------
 * Everything that "chases" people - due dates, escalations, overdue reviews -
 * used to be computed only when somebody opened a page. That makes the system
 * passive. This process closes the gap: it is the difference between a tool you
 * consult and a workflow that runs.
 *
 * AUDIT-TRAIL DISCIPLINE
 * ----------------------
 * A monitor that writes to the audit trail every cycle would drown the ledger
 * in noise, so: audit STATE CHANGES, never scans. Notifications carry a
 * `dedupe_key` unique index, so repeated cycles are idempotent and the process
 * can be killed and restarted without double-counting.
 *
 * Automated writes are attributed to a `monitor` system actor (actor_id NULL),
 * so any auditor can separate machine-generated events from human ones.
 */

const path = require('node:path');
const config = require('../config');
const db = require('../core/db');
const audit = require('../core/audit');

// ---------------------------------------------------------------- options ---

function parseArgs(argv) {
  const opts = {
    once: false,
    verbose: false,
    intervalSeconds: Number(process.env.PE_MONITOR_INTERVAL || 300),
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') opts.once = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--interval') opts.intervalSeconds = Number(argv[++i]) || 300;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const MONITOR_CTX = { ip: null, userAgent: 'monitor', sessionId: null };

function log(opts, msg) {
  if (opts.verbose) process.stdout.write(`  [monitor] ${new Date().toISOString()} ${msg}\n`);
}

function notify({ title, body, level = 'warning', link = null, role = null, dedupeKey }) {
  if (!dedupeKey) return false;
  const exists = db.get('SELECT id FROM notifications WHERE dedupe_key = ?', [dedupeKey]);
  if (exists) return false;
  db.run(
    'INSERT INTO notifications (user_id, role, title, body, level, link, created_at, dedupe_key) VALUES (?,?,?,?,?,?,?,?)',
    [null, role || null, title, body, level, link || null, new Date().toISOString(), dedupeKey]
  );
  return true;
}

/**
 * One scan cycle. Every branch is idempotent.
 */
function scanOnce(opts) {
  const actions = [];
  const now = new Date().toISOString().slice(0, 10);

  // 1. Overdue workflow records: notify the next-step role; escalate critical
  //    records that are > 30 days past due to the HEOR lead.
  const overdue = db.all(
    `SELECT i.id, i.record_key, i.title, i.process_code, i.criticality, i.due_date,
            s.step_code, s.name AS step_name, s.assignee_role
     FROM workflow_instances i
     JOIN workflow_steps s ON s.instance_id = i.id AND s.status != 'completed'
     WHERE i.due_date < date('now') AND i.closed_at IS NULL
       AND i.status NOT IN ('closed','cancelled','rejected')
     ORDER BY i.criticality = 'critical' DESC, i.due_date ASC`
  );
  for (const r of overdue) {
    const role = parseRole(r.assignee_role);
    if (notify({
      title: `${r.record_key} 已超期（${r.process_code}）`,
      body: `${r.title} — 等待步骤「${r.step_name}」${role ? `（责任角色：${role.join('/')}）` : ''}，截止日期 ${r.due_date}。`,
      level: r.criticality === 'critical' ? 'critical' : 'warning',
      link: '#/records',
      role: role ? role[0] : null,
      dedupeKey: `overdue:${r.id}:${r.due_date}`,
    })) actions.push(`notified overdue ${r.record_key}`);

    const daysLate = Math.ceil((Date.now() - Date.parse(r.due_date)) / 86400000);
    if (r.criticality === 'critical' && daysLate >= 30) {
      if (notify({
        title: `${r.record_key} 严重超期（≥30 天），已升级`,
        body: `${r.title}：critical 级记录超期 ${daysLate} 天，需 HEOR 负责人介入处置。`,
        level: 'critical',
        link: '#/records',
        role: 'heor_lead',
        dedupeKey: `escalate:${r.id}:critical:30`,
      })) actions.push(`escalated ${r.record_key}`);
    }
  }

  // 2. Document review backlog.
  const docs = db.all(
    `SELECT id, doc_number, title FROM documents
     WHERE next_review_date < date('now') AND status != 'obsolete'`
  );
  for (const d of docs) {
    if (notify({
      title: `${d.doc_number} 定期审核已超期`,
      body: `${d.title}：文件定期审核（周期性复核）已到期。`,
      level: 'warning',
      link: '#/documents',
      role: 'heor_qa',
      dedupeKey: `docreview:${d.id}`,
    })) actions.push(`notified doc review ${d.doc_number}`);
  }

  // 3. Open critical assessment findings need closing before submission.
  const findings = db.all(
    `SELECT f.id, f.risk_level, i.code AS assessment_code
     FROM inspection_findings f JOIN inspections i ON i.id = f.inspection_id
     WHERE f.risk_level = 'critical' AND f.status IN ('open', 'in_treatment')`
  );
  for (const f of findings) {
    if (notify({
      title: `${f.assessment_code} 存在未关闭的严重(critical)缺陷`,
      body: '报告不得带着 critical 级缺陷对外提交；请评估缺陷或转记录处理。',
      level: 'critical',
      link: '#/assessments',
      role: 'heor_qa',
      dedupeKey: `finding:${f.id}:critical:open`,
    })) actions.push(`notified critical finding ${f.assessment_code}#${f.id}`);
  }

  return actions;
}

function parseRole(stored) {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* single role string */ }
  return [String(stored)];
}

// ------------------------------------------------------------------ main ----

function main() {
  const opts = parseArgs(process.argv);
  db.open();
  if (opts.help) {
    process.stdout.write(
      'PE-Workbench background monitor\n' +
      '  --once             run a single cycle and exit\n' +
      '  --interval N       cycle every N seconds (default 300)\n' +
      '  --verbose          print each action\n'
    );
    db.close();
    return;
  }

  const runCycle = () => {
    try {
      const actions = scanOnce(opts);
      if (opts.verbose && actions.length) {
        process.stdout.write(`  [monitor] ${actions.length} action(s):\n    - ${actions.join('\n    - ')}\n`);
      }
    } catch (err) {
      process.stderr.write(`  [monitor] cycle failed: ${err.message}\n`);
    }
  };

  runCycle();
  if (opts.once) {
    db.close();
    return;
  }

  process.stdout.write(`  [monitor] running every ${opts.intervalSeconds}s (PE-Monitor); Ctrl+C to stop.\n`);
  const timer = setInterval(runCycle, opts.intervalSeconds * 1000);
  timer.unref();
  process.on('SIGTERM', () => { try { db.close(); } catch { /* noop */ } process.exit(0); });
  process.on('SIGINT', () => { try { db.close(); } catch { /* noop */ } process.exit(0); });
}

if (require.main === module) main();
module.exports = { scanOnce, notify, parseRole };