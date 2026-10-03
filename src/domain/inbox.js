'use strict';

/**
 * Inbox - "what do I need to submit, verify or approve right now?".
 *
 * The dashboard answers a managerial question ("how is the programme doing?").
 * This answers the individual's question: what is waiting on *me*, and what
 * happens if I ignore it.
 *
 * Sources merged into one ranked list:
 *   1. workflow steps whose responsible role includes the current user;
 *   2. assessment findings assigned to roles the user can act on (QA);
 *   3. notifications from the background monitor (escalations, overdue items).
 *
 * Ranking is by consequence first (critical issues, signature gates, overdue),
 * then by due date — not by insertion time.
 */

const db = require('../core/db');
const workflow = require('./workflow');
const rbac = require('../core/rbac');
const constraints = require('./constraints');

function nowIso() { return new Date().toISOString(); }

const CONSEQUENCE_ORDER = { critical: 0, major: 1, minor: 2 };

/**
 * The user's inbox: pending steps + signable items + escalations.
 */
function inbox(user, filters = {}) {
  const steps = workflow.myActions(user, 200);

  const items = steps.map((s) => ({
    kind: 'step',
    entityType: 'workflow',
    recordKey: s.recordKey,
    instanceId: s.instanceId,
    title: s.title,
    processCode: s.processCode,
    stepCode: s.stepCode,
    stepName: s.stepName,
    stepNameEn: s.stepNameEn,
    action: actionLabel(s.signatureMeaning),
    requiresSignature: Boolean(s.signatureMeaning),
    criticality: s.criticality || 'major',
    dueDate: s.dueDate,
    overdue: s.overdue,
    overdueDays: s.overdue ? daysOverdue(s.dueDate) : 0,
    link: `#/records/${s.instanceId}`,
  }));

  // Assessment findings open for QA action (negative grades need response/close).
  if (rbac.hasPermission(user, 'inspection.manage') || rbac.hasPermission(user, 'cheers.manage')) {
    const findings = db.all(
      `SELECT f.id AS findingId, f.risk_level, f.assessed_grade, f.status, f.due_date, f.requirement,
              i.code AS assessmentCode, i.title AS assessmentTitle
       FROM inspection_findings f
       JOIN inspections i ON i.id = f.inspection_id
       WHERE f.status IN ('open', 'in_treatment')
         AND f.assessed_grade IN ('gap', 'partial')
       ORDER BY CASE f.risk_level WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, f.due_date IS NULL`
    );
    for (const f of findings) {
      items.push({
        kind: 'finding',
        entityType: 'finding',
        findingId: f.findingId,
        recordKey: `${f.assessmentCode}#${f.findingId}`,
        title: `${f.assessmentCode}：${String(f.requirement).slice(0, 60)}`,
        assessmentCode: f.assessmentCode,
        stepName: '缺陷处置',
        action: f.status === 'in_treatment' ? '跟踪直至关闭' : '评估/转记录/关闭',
        requiresSignature: false,
        criticality: f.risk_level,
        dueDate: f.due_date,
        overdue: f.due_date ? Date.parse(f.due_date) < Date.now() : false,
        overdueDays: f.due_date ? daysOverdue(f.due_date) : 0,
        link: `#/assessments/${f.assessmentCode}`,
      });
    }
  }

  // Escalated notifications from the monitor.
  const escalations = db.all(
    `SELECT title, body, level, link, created_at FROM notifications
     WHERE (user_id = ? OR role = ?) AND read_at IS NULL AND level IN ('critical', 'warning')
     ORDER BY created_at DESC LIMIT 20`,
    [user.id, user.role]
  );
  for (const n of escalations) {
    items.push({
      kind: 'notification',
      entityType: 'notification',
      title: n.title,
      stepName: '系统提醒',
      action: n.body,
      requiresSignature: false,
      criticality: n.level === 'critical' ? 'critical' : 'major',
      dueDate: null,
      overdue: false,
      overdueDays: 0,
      link: n.link || null,
    });
  }

  const sorted = items.sort((a, b) => {
    const ca = CONSEQUENCE_ORDER[a.criticality] ?? 2;
    const cb = CONSEQUENCE_ORDER[b.criticality] ?? 2;
    if (ca !== cb) return ca - cb;
    if (Boolean(b.requiresSignature) !== Boolean(a.requiresSignature)) {
      return b.requiresSignature ? -1 : 1;
    }
    if (Boolean(a.overdue) !== Boolean(b.overdue)) return a.overdue ? -1 : 1;
    if (!a.dueDate || !b.dueDate) return a.dueDate ? -1 : (b.dueDate ? 1 : 0);
    return Date.parse(a.dueDate) - Date.parse(b.dueDate);
  });

  const filtered = filters.kind
    ? sorted.filter((i) => i.kind === filters.kind)
    : sorted;

  return {
    total: filtered.length,
    byKind: {
      step: filtered.filter((i) => i.kind === 'step').length,
      finding: filtered.filter((i) => i.kind === 'finding').length,
      notification: filtered.filter((i) => i.kind === 'notification').length,
    },
    requiresSignature: filtered.filter((i) => i.requiresSignature).length,
    overdue: filtered.filter((i) => i.overdue).length,
    items: filtered,
    permissionScope: permissionScope(user),
  };
}

function daysOverdue(dueDate) {
  return Math.max(0, Math.ceil((Date.now() - Date.parse(dueDate)) / 86400000));
}

function actionLabel(signatureMeaning) {
  const labels = {
    approved: '批准（需电子签名）',
    reviewed: '审阅（需电子签名）',
    verified: '核实/验证（需电子签名）',
    closed: '关闭（需电子签名）',
    performed: '执行（需电子签名）',
    completed: '完成',
  };
  return labels[signatureMeaning] || '提交/完成';
}

/**
 * "你的权限范围" —— 说明这个岗位能做什么、不能做什么，并给出约束理由。
 * 让操作者看到空页签时知道系统没有坏。
 */
function permissionScope(user) {
  const perms = rbac.permissionsFor(user.role);
  const roleDef = rbac.ROLES[user.role];
  const write = perms.filter((p) => !p.startsWith('doc.view') && !p.startsWith('record.view')
    && !p.startsWith('audit.view') && !p.startsWith('training.view') && !p.startsWith('inspection.view')
    && !p.startsWith('compliance.view'));
  const denied = [];
  const conditional = [];
  for (const c of constraints.CONSTRAINTS) {
    for (const p of c.permissions || []) {
      if (!perms.includes(p) && perms.join() !== '*') denied.push({ permission: p, reason: c.description });
    }
    if (perms.includes('*')) conditional.push({ constraint: c.name, reason: c.description });
  }
  return {
    role: user.role,
    roleLabel: roleDef ? roleDef.labelZh : user.role,
    readonly: rbac.isReadOnly(user),
    granted: [...new Set(write)],
    constrained: conditional,
    deniedPreview: [...new Set(denied.map((d) => d.permission))].slice(0, 8),
  };
}

module.exports = { inbox, permissionScope, daysOverdue };