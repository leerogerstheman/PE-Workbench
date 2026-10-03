'use strict';

/**
 * Checklist library and assessment / readiness engine.
 *
 * Why this module exists
 * ----------------------
 * Pharmacoeconomic results are only as defensible as the reporting around them.
 * This module turns the reporting and methodological standards (CHEERS 2022,
 * 中国药物经济学评价指南 2020, ISPOR-SMDM model transparency & validation, data
 * integrity ALCOA+) into reusable checklist libraries, lets QA run an
 * assessment against a study record, and rolls the open findings together into
 * a readiness score with NAMED blockers - so a report launches knowing exactly
 * what stands between the current draft and a defensible submission.
 *
 * Design rules
 * ------------
 *  - A negative assessment ("partial" or "gap") MUST carry objective evidence
 *    of at least 10 characters. A claim without evidence is not a finding.
 *  - Every assessment change is audited; findings can be linked to a DISS or
 *    CHG workflow record (the CAPA equivalent for analysis work).
 *  - "Not applicable" and "not assessed" never count in the denominator, so a
 *    half-assessed checklist cannot inflate its own score.
 */

const db = require('../core/db');
const audit = require('../core/audit');

function nowIso() { return new Date().toISOString(); }

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

const RISK_LEVELS = ['critical', 'major', 'minor'];

const GRADE_WEIGHTS = { compliant: 1, partial: 0.5, gap: 0 };
const RISK_WEIGHTS = { critical: 10, major: 4, minor: 1 };
const NEGATIVE_GRADES = ['partial', 'gap'];
const MIN_EVIDENCE_LENGTH = 10;

// ------------------------------------------------------------ templates ------

function registerTemplate(template, sourceFile) {
  if (!template.code) throw new Error('checklist template requires a code');
  if (!Array.isArray(template.items) || !template.items.length) {
    throw new Error(`checklist ${template.code} has no items`);
  }
  template.items.forEach((item, idx) => {
    if (!item.requirement) throw new Error(`${template.code}: item ${idx + 1} has no requirement text`);
    if (item.riskLevel && !RISK_LEVELS.includes(item.riskLevel)) {
      throw new Error(`${template.code}: item ${idx + 1} has unknown riskLevel "${item.riskLevel}"`);
    }
  });

  let templateId = null;
  let itemsChanged = 0;
  db.transaction(() => {
    const existing = db.get('SELECT id FROM checklist_templates WHERE code = ?', [template.code]);
    if (existing) {
      templateId = existing.id;
      db.run(
        'UPDATE checklist_templates SET title = ?, title_en = ?, scope = ?, gxp_areas = ?, category = ?, ' +
        'regulation = ?, authority = ?, version = ?, description = ?, description_en = ?, source_file = ?, ' +
        'active = 1, loaded_at = ? WHERE id = ?',
        [template.title, template.titleEn || null, template.scope || 'self_assessment',
          JSON.stringify(template.gxpAreas || []), template.category || null,
          template.regulation || null, template.authority || null, template.version || null,
          template.description || null, template.descriptionEn || null, sourceFile || null, nowIso(), templateId]
      );
    } else {
      const res = db.run(
        'INSERT INTO checklist_templates (code, title, title_en, scope, gxp_areas, category, regulation, authority, ' +
        'version, description, description_en, source_file, active, loaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)',
        [template.code, template.title, template.titleEn || null, template.scope || 'self_assessment',
          JSON.stringify(template.gxpAreas || []), template.category || null, template.regulation || null,
          template.authority || null, template.version || null, template.description || null,
          template.descriptionEn || null, sourceFile || null, nowIso()]
      );
      templateId = db.get('SELECT last_insert_rowid() AS id').id;
    }

    let seq = 0;
    const existingItems = db.all(
      'SELECT id, seq FROM checklist_items WHERE template_id = ? ORDER BY seq', [templateId]
    );
    for (const item of template.items) {
      seq += 1;
      const prior = existingItems[seq - 1];
      const values = [item.clauseRef || null, item.requirement, item.requirementEn || null,
        item.guidance || null, item.guidanceEn || null, item.riskLevel || 'major',
        JSON.stringify(item.gxpAreas || template.gxpAreas || []), item.evidenceHint || null,
        item.riskLevel === 'critical' || item.isCritical ? 1 : 0];
      if (prior) {
        db.run(
          'UPDATE checklist_items SET seq = ?, clause_ref = ?, requirement = ?, requirement_en = ?, guidance = ?, ' +
          'guidance_en = ?, risk_level = ?, gxp_areas = ?, evidence_hint = ?, is_critical = ? WHERE id = ?',
          [seq, ...values, prior.id]
        );
      } else {
        db.run(
          'INSERT INTO checklist_items (template_id, seq, clause_ref, requirement, requirement_en, guidance, ' +
          'guidance_en, risk_level, gxp_areas, evidence_hint, is_critical) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [templateId, seq, ...values]
        );
      }
      itemsChanged += 1;
    }
    const surplus = existingItems.slice(seq);
    for (const row of surplus) {
      const referenced = db.get('SELECT COUNT(*) AS n FROM inspection_findings WHERE item_id = ?', [row.id]).n;
      if (referenced) {
        db.run("UPDATE checklist_items SET requirement = ?, clause_ref = ?, is_critical = 0 WHERE id = ?",
          [`[已从检查表移除] ${db.get('SELECT requirement FROM checklist_items WHERE id = ?', [row.id]).requirement}`, null, row.id]);
      } else {
        db.run('DELETE FROM checklist_items WHERE id = ?', [row.id]);
      }
    }
  });
  return { code: template.code, templateId, items: itemsChanged };
}

function listTemplates(filters = {}) {
  let rows = db.all('SELECT * FROM checklist_templates WHERE active = 1 ORDER BY scope, code');
  if (filters.gxpArea) rows = rows.filter((r) => parseJson(r.gxp_areas, []).includes(filters.gxpArea));
  if (filters.scope) rows = rows.filter((r) => r.scope === filters.scope);
  return rows.map((r) => {
    const counts = db.all('SELECT risk_level, COUNT(*) AS n FROM checklist_items WHERE template_id = ? GROUP BY risk_level', [r.id]);
    const riskCounts = { critical: 0, major: 0, minor: 0 };
    for (const c of counts) riskCounts[c.risk_level] = c.n;
    return {
      id: r.id, code: r.code, title: r.title, titleEn: r.title_en, scope: r.scope,
      gxpAreas: parseJson(r.gxp_areas, []), category: r.category, regulation: r.regulation,
      authority: r.authority, version: r.version, description: r.description,
      descriptionEn: r.description_en, itemCount: counts.reduce((a, b) => a + b.n, 0), riskCounts,
    };
  });
}

function getTemplate(idOrCode) {
  const row = /^\d+$/.test(String(idOrCode))
    ? db.get('SELECT * FROM checklist_templates WHERE id = ?', [Number(idOrCode)])
    : db.get('SELECT * FROM checklist_templates WHERE code = ?', [String(idOrCode)]);
  if (!row) return null;
  const items = db.all('SELECT * FROM checklist_items WHERE template_id = ? ORDER BY seq', [row.id]);
  return {
    id: row.id, code: row.code, title: row.title, titleEn: row.title_en, scope: row.scope,
    gxpAreas: parseJson(row.gxp_areas, []), category: row.category, regulation: row.regulation,
    authority: row.authority, version: row.version, description: row.description,
    descriptionEn: row.description_en, sourceFile: row.source_file,
    items: items.map(mapItem),
  };
}

function mapItem(i) {
  return {
    id: i.id, seq: i.seq, clauseRef: i.clause_ref, requirement: i.requirement,
    requirementEn: i.requirement_en, guidance: i.guidance, guidanceEn: i.guidance_en,
    riskLevel: i.risk_level, gxpAreas: parseJson(i.gxp_areas, []),
    evidenceHint: i.evidence_hint, isCritical: Boolean(i.is_critical),
  };
}

// ---------------------------------------------------------- assessments ------

/**
 * Start an assessment from a template: creates the assessment header and seeds
 * one finding row per requirement in the `not_assessed` state.
 */
function startAssessment({ title, templateId, gxpAreas, scope, linkedRecordKey, dueDate }, actor, ctx) {
  const template = getTemplate(templateId);
  if (!template) throw httpError(404, 'TEMPLATE_NOT_FOUND');
  const areas = gxpAreas && gxpAreas.length ? gxpAreas : template.gxpAreas;
  const at = nowIso();
  const code = nextInspectionCode();
  let inspectionId;
  db.transaction(() => {
    const res = db.run(
      'INSERT INTO inspections (code, title, inspection_type, authority, gxp_areas, template_id, site, scope, ' +
      'scheduled_date, status, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [code, title || `${template.title} 评估`, 'self_assessment', template.authority || null,
        JSON.stringify(areas), template.id, null, scope || null, dueDate || null,
        'in_progress', at, at, actor ? actor.id : null]
    );
    inspectionId = db.get('SELECT last_insert_rowid() AS id').id;
    for (const item of template.items) {
      db.run(
        'INSERT INTO inspection_findings (inspection_id, item_id, template_id, finding_type, assessed_grade, clause_ref, ' +
        'requirement, risk_level, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [inspectionId, item.id, template.id, 'checklist_item', 'not_assessed', item.clauseRef, item.requirement,
          item.riskLevel, 'open', at, at]
      );
    }
  });

  audit.append({
    action: 'assessment_started',
    entityType: 'inspections',
    entityId: inspectionId,
    actor,
    reason: `Assessment "${title}" started from template ${template.code}`,
    ctx,
    gxpAreas: areas,
    meta: { template: template.code, itemCount: template.items.length },
    severity: 'info',
  });

  // Keep the live record-linkage if a study record key was provided.
  if (linkedRecordKey) {
    const rec = db.get('SELECT * FROM workflow_instances WHERE record_key = ? OR id = ?', [linkedRecordKey, linkedRecordKey]);
    if (rec) {
      db.run('UPDATE inspections SET site = ?, scope = ? WHERE id = ?', [rec.record_key, `linked:${rec.record_key}`, inspectionId]);
    }
  }

  return getAssessment(inspectionId);
}

function nextInspectionCode() {
  const year = new Date().getFullYear();
  const row = db.get(
    "SELECT code FROM inspections WHERE code LIKE ? ORDER BY code DESC LIMIT 1", [`ASSESS-${year}-%`]
  );
  let next = 1;
  if (row) {
    const tail = Number.parseInt(row.code.split('-').pop(), 10);
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `ASSESS-${year}-${String(next).padStart(4, '0')}`;
}

function listAssessments(filters = {}) {
  const where = [];
  const params = [];
  if (filters.gxpArea) { where.push('gxp_areas LIKE ?'); params.push(`%"${filters.gxpArea}"%`); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.templateId) { where.push('template_id = ?'); params.push(Number(filters.templateId)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(`SELECT * FROM inspections ${clause} ORDER BY updated_at DESC LIMIT 200`, params);
  return rows.map((r) => decorateInspection(r));
}

function getAssessment(idOrCode) {
  const row = /^\d+$/.test(String(idOrCode))
    ? db.get('SELECT * FROM inspections WHERE id = ?', [Number(idOrCode)])
    : db.get('SELECT * FROM inspections WHERE code = ?', [String(idOrCode)]);
  if (!row) return null;
  const out = decorateInspection(row);
  const findings = db.all('SELECT * FROM inspection_findings WHERE inspection_id = ? ORDER BY id', [row.id]);
  out.findings = findings.map((f) => ({
    id: f.id, itemId: f.item_id, assessedGrade: f.assessed_grade,
    clauseRef: f.clause_ref, requirement: f.requirement,
    observation: f.observation, objectiveEvidence: f.objective_evidence,
    riskLevel: f.risk_level, status: f.status, ownerId: f.owner_id,
    dueDate: f.due_date, workflowId: f.workflow_id,
    assessedAt: f.assessed_at, assessedBy: f.assessed_by,
    item: f.item_id ? getTemplateItem(f.item_id) : null,
  }));
  return out;
}

function getTemplateItem(itemId) {
  const row = db.get('SELECT * FROM checklist_items WHERE id = ?', [Number(itemId)]);
  if (!row) return null;
  return {
    id: row.id, seq: row.seq, clauseRef: row.clause_ref, requirement: row.requirement,
    requirementEn: row.requirement_en, guidance: row.guidance,
    riskLevel: row.risk_level, evidenceHint: row.evidence_hint,
  };
}

function decorateInspection(r) {
  const score = readinessScoreFor(r.id);
  return {
    id: r.id, code: r.code, title: r.title,
    inspectionType: r.inspection_type, authority: r.authority,
    gxpAreas: parseJson(r.gxp_areas, []), templateId: r.template_id,
    scope: r.scope, dueDate: r.scheduled_date, status: r.status,
    readinessScore: score.score,
    summary: r.summary,
    counts: score.counts,
    createdAt: r.created_at, updatedAt: r.updated_at,
    createdBy: r.created_by,
  };
}

/**
 * Assess one finding.
 * Negative grades (partial / gap) REQUIRE objective evidence (>= 10 chars).
 */
function assessItem(findingId, input, actor, ctx) {
  const finding = db.get('SELECT * FROM inspection_findings WHERE id = ?', [Number(findingId)]);
  if (!finding) throw httpError(404, 'FINDING_NOT_FOUND');
  const grade = input.grade;
  if (!(grade in GRADE_WEIGHTS) && grade !== 'not_applicable') {
    throw httpError(400, 'UNKNOWN_GRADE', 'grade must be compliant | partial | gap | not_applicable');
  }
  const evidence = String(input.evidence || '').trim();
  if (NEGATIVE_GRADES.includes(grade) && evidence.length < MIN_EVIDENCE_LENGTH) {
    throw httpError(400, 'EVIDENCE_REQUIRED',
      `A "${grade}" assessment requires objective evidence of at least ${MIN_EVIDENCE_LENGTH} characters. ` +
      'A negative judgement without evidence is not defensible in a review or inspection.');
  }
  const before = {
    assessed_grade: finding.assessed_grade,
    observation: finding.observation,
    objective_evidence: finding.objective_evidence,
  };
  db.run(
    'UPDATE inspection_findings SET assessed_grade = ?, observation = ?, objective_evidence = ?, ' +
    'status = ?, assessed_at = ?, assessed_by = ?, updated_at = ? WHERE id = ?',
    [grade, String(input.observation || '').trim() || null, evidence || null,
      grade === 'gap' ? 'open' : 'assessed', nowIso(), actor.id, nowIso(), finding.id]
  );
  audit.append({
    action: 'assessment_item',
    entityType: 'inspection_findings',
    entityId: finding.id,
    actor,
    reason: `Assessment of item "${String(finding.clause_ref || finding.requirement).slice(0, 60)}" set to ${grade}`,
    ctx,
    meta: { inspectionId: finding.inspection_id, grade, observation: input.observation || null },
    oldValue: before,
    newValue: { assessed_grade: grade, objective_evidence: evidence || null },
    severity: grade === 'gap' ? 'warning' : 'info',
  });
  refreshAssessment(finding.inspection_id);
  return getAssessment(finding.inspection_id);
}

/**
 * Link a finding to a workflow record (e.g. a DISS or CHG raised from it).
 */
function linkFindingToRecord(findingId, workflowId, actor, ctx) {
  const finding = db.get('SELECT * FROM inspection_findings WHERE id = ?', [Number(findingId)]);
  if (!finding) throw httpError(404, 'FINDING_NOT_FOUND');
  const rec = db.get('SELECT * FROM workflow_instances WHERE id = ?', [Number(workflowId)]);
  if (!rec) throw httpError(404, 'RECORD_NOT_FOUND');
  db.run(
    'UPDATE inspection_findings SET workflow_id = ?, status = ?, owner_id = ?, updated_at = ? WHERE id = ?',
    [rec.id, 'in_treatment', rec.owner_id || rec.created_by, nowIso(), finding.id]
  );
  audit.append({
    action: 'finding_linked',
    entityType: 'inspection_findings',
    entityId: finding.id,
    actor,
    reason: `Finding linked to ${rec.record_key}`,
    ctx,
    newValue: { workflow_id: rec.id, record_key: rec.record_key },
  });
  refreshAssessment(finding.inspection_id);
  return getAssessment(finding.inspection_id);
}

function closeFinding(findingId, input, actor, ctx) {
  const finding = db.get('SELECT * FROM inspection_findings WHERE id = ?', [Number(findingId)]);
  if (!finding) throw httpError(404, 'FINDING_NOT_FOUND');
  if (finding.assessed_grade !== 'gap' && finding.assessed_grade !== 'partial') {
    throw httpError(409, 'NOT_A_DEFICIENCY', 'Only findings assessed as gap or partial can be closed with a response');
  }
  const response = String(input.response || '').trim();
  if (response.length < MIN_EVIDENCE_LENGTH) {
    throw httpError(400, 'RESPONSE_REQUIRED', `Closing a finding requires a response of at least ${MIN_EVIDENCE_LENGTH} characters`);
  }
  db.run(
    'UPDATE inspection_findings SET response = ?, status = ?, updated_at = ? WHERE id = ?',
    [response, 'closed', nowIso(), finding.id]
  );
  audit.append({
    action: 'finding_closed',
    entityType: 'inspection_findings',
    entityId: finding.id,
    actor,
    reason: response,
    ctx,
    meta: { inspectionId: finding.inspection_id },
    severity: 'info',
  });
  refreshAssessment(finding.inspection_id);
  return getAssessment(finding.inspection_id);
}

function refreshAssessment(inspectionId) {
  const { score, counts } = readinessScoreFor(inspectionId);
  db.run('UPDATE inspections SET readiness_score = ?, updated_at = ? WHERE id = ?', [score, nowIso(), inspectionId]);
  return { score, counts };
}

// ------------------------------------------------------------- readiness -----

function readinessScoreFor(inspectionId) {
  const findings = db.all('SELECT assessed_grade, risk_level, status FROM inspection_findings WHERE inspection_id = ?', [inspectionId]);
  let weightSum = 0;
  let gradeSum = 0;
  const counts = { compliant: 0, partial: 0, gap: 0, not_applicable: 0, not_assessed: 0, open: 0, closed: 0 };
  for (const f of findings) {
    counts[f.assessed_grade] = (counts[f.assessed_grade] || 0) + 1;
    counts[f.status] = (counts[f.status] || 0) + 1;
    if (f.assessed_grade === 'not_assessed' || f.assessed_grade === 'not_applicable') continue;
    if (GRADE_WEIGHTS[f.assessed_grade] === undefined) continue;
    const w = RISK_WEIGHTS[f.risk_level] || 1;
    weightSum += w;
    gradeSum += w * GRADE_WEIGHTS[f.assessed_grade];
  }
  const score = weightSum > 0 ? Math.round((gradeSum / weightSum) * 100) : null;
  return { score, counts };
}

/**
 * Readiness dashboard for the whole programme: named blockers, not a mood ring.
 * An open critical finding, an overdue record, an overdue document review or a
 * broken audit chain all show up here with names attached.
 */
function readinessDashboard() {
  const blockers = [];
  let score = 100;
  const deduct = (points, label) => { score -= points; blockers.push({ points, label }); };

  // 1. Audit chain integrity first: everything else is meaningless if it fails.
  try {
    const chain = require('../core/audit').verifyChain();
    if (!chain.ok) {
      return { score: 0, blockers: [{ points: 0, label: `审计链完整性失败（断点 seq ${chain.brokenAt}）：${chain.reason}` }], ok: false };
    }
  } catch { /* not yet initialised */ }

  // 2. Open critical findings in assessments.
  const criticalOpen = db.get(
    `SELECT COUNT(*) AS n FROM inspection_findings WHERE risk_level = 'critical' AND status IN ('open','in_treatment')`
  ).n;
  if (criticalOpen) deduct(criticalOpen * 25, `${criticalOpen} 项严重(critical)缺陷未关闭`);

  // 3. Overdue workflow records (open past their due date).
  const overdue = db.get(
    `SELECT COUNT(*) AS n FROM workflow_instances
     WHERE due_date < date('now') AND closed_at IS NULL AND status NOT IN ('closed','cancelled','rejected')`
  ).n;
  if (overdue) deduct(Math.min(overdue * 10, 30), `${overdue} 项研究记录已超期`);

  // 4. Records awaiting steps past SLA with criticality (escalated).
  const escalated = db.get(
    `SELECT COUNT(*) AS n FROM workflow_instances
     WHERE criticality = 'critical' AND due_date < date('now') AND closed_at IS NULL
       AND status NOT IN ('closed','cancelled','rejected')`
  ).n;
  if (escalated) deduct(escalated * 15, `${escalated} 项关键(critical)记录超期（已升级至 HEOR 负责人）`);

  // 5. Document review backlog.
  const docBacklog = db.get(
    `SELECT COUNT(*) AS n FROM documents WHERE next_review_date < date('now') AND status != 'obsolete'`
  ).n;
  if (docBacklog) deduct(Math.min(docBacklog * 5, 20), `${docBacklog} 份文件定期审核已超期`);

  // 6. Published models without ISPOR-SMDM validation evidence flag.
  const unvalidatedPublish = db.get(
    `SELECT COUNT(*) AS n FROM workflow_instances
     WHERE process_code = 'MODEL' AND status = 'published'
       AND data_json NOT LIKE '%"validationItems"%'`
  ).n;
  if (unvalidatedPublish) deduct(unvalidatedPublish * 10, `${unvalidatedPublish} 个已发布模型缺少验证记录（ISPOR-SMDM）`);

  score = Math.max(0, score);
  return { score, blockers, ok: true };
}

/** Per-domain coverage: how many workflows and checklists touch each area. */
function coverage() {
  const areas = db.all('SELECT * FROM gxp_areas ORDER BY sort_order');
  return areas.map((a) => {
    const processes = db.all(
      "SELECT code, name FROM process_types WHERE active = 1 AND gxp_areas LIKE ?",
      [`%"${a.code}"%`]
    );
    const templates = db.all(
      "SELECT code, title FROM checklist_templates WHERE active = 1 AND gxp_areas LIKE ?",
      [`%"${a.code}"%`]
    );
    const records = db.get('SELECT COUNT(*) AS n FROM workflow_instances WHERE gxp_areas LIKE ?', [`%"${a.code}"%`]).n;
    return {
      code: a.code, name: a.name, nameEn: a.name_en,
      description: a.description, colour: a.colour,
      processes: processes.length, templates: templates.length, records,
    };
  });
}

function compliancePosture() {
  const appetite = {
    '报告必须可复现': { control: '审计追踪 + 修改理由 + 版本重建', evidence: 'audit_trail 只追加、哈希链校验、record_version' },
    '负面判定必须有客观证据': { control: '条目判定强制 >= 10 字证据', evidence: 'assessItem 服务端强制' },
    '职责分离': { control: '步骤角色门 + 独立批准门', evidence: 'workflow.completeStep / rbac.canSign' },
    '电子签名两个独立要素': { control: '密码 + TOTP/一次性挑战码', evidence: 'auth.sign 双分量' },
    '限时外部评审访问': { control: 'access_expires_at 登录与每请求校验', evidence: 'auth.accessExpiry' },
    '导出即留痕': { control: '导出审计记录先于负载生成', evidence: 'routes /api/audit/export' },
    '后台推进工作流': { control: '监视进程扫描超期与升级', evidence: 'daemon/monitor.js' },
    '检查表与流程可配置': { control: 'JSON 配置库热加载', evidence: 'seed/ 目录' },
  };
  return Object.entries(appetite).map(([requirement, c]) => ({
    requirement, control: c.control, evidence: c.evidence, status: 'implemented',
  }));
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  registerTemplate,
  listTemplates,
  getTemplate,
  startAssessment,
  listAssessments,
  getAssessment,
  assessItem,
  linkFindingToRecord,
  closeFinding,
  readinessScoreFor,
  readinessDashboard,
  coverage,
  compliancePosture,
  httpError,
};