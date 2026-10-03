'use strict';

/**
 * Dashboard aggregation.
 *
 * The point of this module is to answer, on one screen, the three questions a
 * pharmacoeconomics analyst actually has:
 *   1. What must I do today?          -> myWork / inbox
 *   2. What is about to bite us?      -> alerts (overdue records, gaps in the
 *                                        CHEERS coverage, validation debt)
 *   3. If an external reviewer walked in now?  -> readiness score + named blockers
 */

const db = require('../core/db');
const audit = require('../core/audit');
const workflow = require('./workflow');
const inspections = require('./inspections');
const inbox = require('./inbox');
const accounts = require('./accounts');

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * The one-screen answer.
 */
function dashboard(user) {
  const chain = audit.verifyChain();
  const readiness = inspections.readinessDashboard();
  const records = workflow.metrics();
  const myInbox = inbox.inbox(user);
  const myWork = workflow.myActions(user, 20);
  const assessments = inspections.listAssessments({});
  const coverage = inspections.coverage();

  return {
    chainOk: chain.ok,
    chainBrokenAt: chain.brokenAt,
    chainChecked: chain.checked,
    readiness: readiness,
    records: {
      total: records.byStatus.reduce((a, r) => a + r.n, 0),
      open: records.byStatus.filter((r) => !['closed', 'cancelled', 'rejected'].includes(r.status))
        .reduce((a, r) => a + r.n, 0),
      overdue: records.byProcess.reduce((a, r) => a + (r.overdue || 0), 0),
      byProcess: records.byProcess,
      ageing: records.ageing,
    },
    assessments: {
      total: assessments.length,
      open: assessments.filter((a) => a.status !== 'closed').length,
      averageScore: assessments.filter((a) => a.readinessScore != null).length
        ? Math.round(assessments.filter((a) => a.readinessScore != null)
            .reduce((s, a) => s + a.readinessScore, 0) / assessments.filter((a) => a.readinessScore != null).length)
        : null,
    },
    myWork: {
      pending: myInbox.total,
      requiresSignature: myInbox.requiresSignature,
      overdue: myInbox.overdue,
      items: myWork,
    },
    alerts: alertsFor(),
    coverage,
    accountCount: db.get('SELECT COUNT(*) AS n FROM users').n,
  };
}

/** Read-only programme-level view for dashboards of non-record roles. */
function programmeSummary() {
  const readiness = inspections.readinessDashboard();
  const records = workflow.metrics();
  return {
    readiness: readiness,
    records: {
      total: records.byStatus.reduce((a, r) => a + r.n, 0),
      open: records.byStatus.filter((r) => !['closed', 'cancelled', 'rejected'].includes(r.status))
        .reduce((a, r) => a + r.n, 0),
      overdue: records.byProcess.reduce((a, r) => a + (r.overdue || 0), 0),
    },
    chainOk: audit.verifyChain().ok,
  };
}

/**
 * Alerts are consequence-ranked and name the offender record - an analyst does
 * not need a paragraph, they need "CEA-2026-0002 缺阈值解读，已超期 3 天".
 */
function alertsFor() {
  const alerts = [];
  const overdue = db.all(
    `SELECT record_key, title, process_code, criticality, due_date, status FROM workflow_instances
     WHERE due_date < date('now') AND closed_at IS NULL
       AND status NOT IN ('closed','cancelled','rejected')
     ORDER BY CASE criticality WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, due_date ASC
     LIMIT 10`
  );
  for (const r of overdue) {
    alerts.push({
      level: r.criticality === 'critical' ? 'critical' : 'warning',
      title: `${r.record_key} 已超期`,
      body: `${r.title}（${r.process_code}），截至 ${r.due_date}`,
      link: '#/records',
    });
  }
  const openCritical = db.get(
    `SELECT COUNT(*) AS n FROM inspection_findings
     WHERE risk_level = 'critical' AND status IN ('open', 'in_treatment')`
  ).n;
  if (openCritical > 0) {
    alerts.push({
      level: 'critical',
      title: `${openCritical} 项严重缺陷未关闭`,
      body: '检查表评估中存在 critical 级缺陷，报告不得带着严重缺陷提交。',
      link: '#/assessments',
    });
  }
  return alerts;
}

/**
 * Compliance posture: the workbench treats itself as the object of review and
 * maps each methodological requirement to a control and its live evidence.
 */
function compliancePosture() {
  return inspections.compliancePosture();
}

module.exports = {
  dashboard,
  programmeSummary,
  alertsFor,
  compliancePosture,
  coverage: inspections.coverage,
};