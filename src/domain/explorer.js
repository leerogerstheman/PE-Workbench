'use strict';

/**
 * Domain workflow explorer.
 *
 * Turns process definitions into the thing a person actually needs to see:
 *   - the steps in order, and who hands what to whom;
 *   - a participant card per responsible role, stating its duties and the
 *     signature meanings it carries;
 *   - a three-state permission matrix per participant, so the interface never
 *     claims a capability the kernel would then refuse.
 *
 * WHY THREE STATES
 * ----------------
 * Permissions alone do not determine what a person may do. The HEOR lead holds
 * `record.close`, and the kernel still refuses to let them close a record they
 * authored. Presenting only allowed/denied would produce a screen that
 * contradicts the running system the first time somebody tries it. So each
 * permission carries ALLOWED / DENIED / CONDITIONAL (with the reason and the
 * methodological basis), sourced from the constraints catalogue.
 *
 * THE PHILOSOPHY BLOCK
 * --------------------
 * Every domain card leads with a short "为什么这个领域这样工作" statement.
 * Workflow details are meaningless until the underlying idea is visible, so
 * each domain carries a philosophy line and the workflow pages echo it.
 */

const db = require('../core/db');
const rbac = require('../core/rbac');
const workflow = require('./workflow');
const constraints = require('./constraints');
const visibility = require('./visibility');
const accounts = require('./accounts');

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * 领域理念 —— 每一条都在直白回答"这个领域为什么这样工作"。
 */
const PHILOSOPHY = {
  RSD: '先想后算。方案是分析的宪法：PICO、视角、时间范围、贴现率在算任何数字之前就要被批准。方案没批准之前产生的数字，都不算数。',
  EVS: '结论必须可溯源。SLR 与 NMA 的一切都从"检索策略先批准"开始——事后补检索式等于没有检索式。低质量证据要被标出，而不是悄悄混进结论。',
  OUT: '结局是怎么打分的必须透明。量表、算法、价值集、来源人群逐项写清；"效用值从哪来"是 HTA 质询的第一现场。',
  CST: '成本不是数字，是"谁付钱、按什么口径、以什么价格"。资源清单先行、单价逐条可溯源、视角决定口径——医保问的是基金的钱。',
  MDL: '模型是一台看不见的机器，所以每一步都要受控：结构评审、参数溯源、编码验证、独立外审。自己建模型的人不能自己放行。',
  ANA: '不确定性不是缺陷，不展示不确定性才是。ICER 必须附带增量成本与增量效果、阈值来源、敏感性结果——结论的稳健性要能被检验。',
  RPT: '写不出来的分析等于没做。按 CHEERS 2022 与《中国药物经济学评价指南》逐项自查，批准、提交、归档全部留痕。',
};

// ------------------------------------------------------------- domains ------

function listDomains() {
  const areas = db.all('SELECT * FROM gxp_areas ORDER BY sort_order');
  const stepCounts = accounts.areaStepCounts();
  return areas.map((a) => {
    const processes = db.all('SELECT * FROM process_types WHERE active = 1 AND gxp_areas LIKE ?', [`%"${a.code}"%`]);
    const roles = accounts.rolesByArea()[a.code] || [];
    const records = db.get('SELECT COUNT(*) AS n FROM workflow_instances WHERE gxp_areas LIKE ?', [`%"${a.code}"%`]).n;
    const templates = db.all('SELECT * FROM checklist_templates WHERE active = 1 AND gxp_areas LIKE ?', [`%"${a.code}"%`]);
    return {
      code: a.code,
      name: a.name,
      nameEn: a.name_en,
      fullName: a.full_name,
      description: a.description,
      colour: a.colour,
      philosophy: PHILOSOPHY[a.code] || null,
      processCount: processes.length,
      roleCount: roles.length,
      recordCount: records,
      checklistCount: templates.length,
      stepTotal: roles.reduce((s, r) => s + (stepCounts[`${a.code}:${r}`] || 0), 0),
    };
  });
}

/**
 * The full domain page: philosophy, workflow cascade (steps with responsible
 * roles), process list, role cards with visibility decisions, three-state
 * permission matrix, checklist coverage and constraints.
 */
function getDomain(domainCode, actor) {
  const area = db.get('SELECT * FROM gxp_areas WHERE code = ?', [String(domainCode)]);
  if (!area) return null;

  const processes = workflow.listProcessTypes({ gxpArea: area.code });
  const rolesInDomain = accounts.rolesByArea()[area.code] || [];
  const stepCounts = accounts.areaStepCounts();
  const templates = db.all(
    'SELECT * FROM checklist_templates WHERE active = 1 AND gxp_areas LIKE ? ORDER BY code',
    [`%"${area.code}"%`]
  );
  const records = workflow.listInstances({ gxpArea: area.code, limit: 50 });

  // Workflow cascade: steps flattened per process with roles and signature gates.
  const cascade = processes.map((p) => ({
    code: p.code,
    name: p.name,
    nameEn: p.nameEn,
    category: p.category,
    slaDays: p.slaDays,
    steps: p.steps.map((s) => ({
      code: s.code, name: s.name, nameEn: s.nameEn, type: s.signatureMeaning ? 'signature' : 'task',
      signatureMeaning: s.signatureMeaning,
      roles: (Array.isArray(s.role) ? s.role : (s.role ? [s.role] : [])).map((r) =>
        rbac.ROLES[r] ? rbac.ROLES[r].labelZh : r),
    })),
  }));

  // Role cards with visibility decisions.
  const roleCards = rolesInDomain.map((role) => {
    const def = rbac.ROLES[role];
    const decision = visibility.decide(actor || null, role);
    const permissionSet = rbac.permissionsFor(role);
    return {
      role,
      label: def ? def.labelZh : role,
      labelEn: def ? def.label : role,
      description: def ? def.description : '',
      stepsInDomain: stepCounts[`${area.code}:${role}`] || 0,
      signatureMeanings: signatureMeaningsForRole(role),
      permissionCount: permissionSet.length,
      visible: decision.visible,
      tier: decision.tier,
      visibilityReason: decision.reason,
      publicFields: decision.publicFields,
    };
  }).sort((a, b) => b.stepsInDomain - a.stepsInDomain);

  // Permission matrix rows relevant to this domain.
  const matrix = permissionMatrix(rolesInDomain, domainPermissionsFor(area.code));

  return {
    code: area.code,
    name: area.name,
    nameEn: area.name_en,
    fullName: area.full_name,
    description: area.description,
    colour: area.colour,
    philosophy: PHILOSOPHY[area.code] || null,
    cascade,
    processes: processes.map((p) => ({
      code: p.code, name: p.name, nameEn: p.nameEn, category: p.category,
      gxpAreas: p.gxpAreas, requiresQaApproval: p.requiresQaApproval,
      slaDays: p.slaDays, stepCount: p.stepCount, description: p.description,
    })),
    roleCards,
    matrix,
    checklists: templates.map((t) => ({
      code: t.code, title: t.title, scope: t.scope, itemCount: itemCountOf(t.id),
    })),
    records: records.rows.slice(0, 20).map((r) => ({
      recordKey: r.recordKey, processCode: r.processCode, title: r.title,
      status: r.status, dueDate: r.dueDate, overdue: r.overdue,
    })),
    visibilityDecisions: visibility.decisionsForDomain(actor || null, area.code),
  };
}

function itemCountOf(templateId) {
  return db.get('SELECT COUNT(*) AS n FROM checklist_items WHERE template_id = ?', [templateId]).n;
}

/** Signature meanings a role can carry across workflows in this domain. */
function signatureMeaningsForRole(role) {
  const meanings = new Set();
  const rows = db.all('SELECT definitions_json FROM process_types WHERE active = 1');
  for (const row of rows) {
    const def = parseJson(row.definitions_json, null);
    if (!def) continue;
    for (const step of def.steps || []) {
      const roles = Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []);
      if (roles.includes(role) && step.signatureMeaning) meanings.add(step.signatureMeaning);
    }
  }
  return [...meanings];
}

const DOMAIN_PERMISSIONS = {
  RSD: ['protocol.manage', 'record.create', 'record.edit', 'record.close', 'doc.approve', 'doc.review', 'audit.view'],
  EVS: ['evidence.manage', 'itc.manage', 'record.create', 'record.edit', 'record.close', 'doc.review'],
  OUT: ['utility.manage', 'record.create', 'record.edit', 'record.close'],
  CST: ['cost.manage', 'record.create', 'record.edit', 'record.close', 'record.export'],
  MDL: ['model.manage', 'model.validate', 'model.publish', 'record.create', 'record.edit', 'record.close', 'change.manage'],
  ANA: ['analysis.manage', 'bia.manage', 'model.validate', 'model.publish', 'record.create', 'record.edit', 'record.close'],
  RPT: ['report.manage', 'cheers.manage', 'submission.manage', 'record.create', 'record.edit', 'record.close', 'record.export', 'doc.approve'],
};

function domainPermissionsFor(areaCode) {
  return DOMAIN_PERMISSIONS[areaCode] || ['record.view', 'record.create', 'record.edit', 'record.close'];
}

/**
 * Three-state permission matrix: rows are permissions, columns are roles.
 * Cell value: 'allowed' | 'denied' | { conditional: constraint reason }.
 */
function permissionMatrix(roles, permissions) {
  const rows = [];
  for (const perm of permissions) {
    const label = permissionLabel(perm);
    const constraintsFor = constraints.forPermission(perm);
    const cells = {};
    for (const role of roles) {
      const granted = rbac.hasPermission({ role }, perm);
      if (!granted) {
        cells[role] = { state: 'denied', reason: '该岗位未持有此权限' };
        continue;
      }
      const hit = constraintsFor.find((c) => (c.permissions || []).includes(perm));
      if (hit) {
        cells[role] = {
          state: 'conditional',
          reason: hit.description,
          basis: hit.basis,
          constraintCode: hit.code,
        };
      } else {
        cells[role] = { state: 'allowed', reason: '岗位权限矩阵授予' };
      }
    }
    rows.push({ permission: perm, label, cells });
  }
  return rows;
}

const PERMISSION_LABELS = {
  'protocol.manage': '方案管理', 'evidence.manage': '证据综述', 'itc.manage': '间接比较',
  'utility.manage': '效用研究', 'cost.manage': '成本测算', 'model.manage': '模型开发',
  'model.validate': '模型验证', 'model.publish': '模型发布', 'bia.manage': '预算影响分析',
  'analysis.manage': '分析与解读', 'report.manage': '报告管理', 'cheers.manage': '报告规范核查',
  'submission.manage': '对外申报', 'change.manage': '变更控制', 'dataissue.manage': '数据问题',
  'record.create': '创建记录', 'record.edit': '修改记录', 'record.close': '关闭记录',
  'record.view': '查看记录', 'record.export': '导出记录', 'doc.review': '文件审阅',
  'doc.approve': '文件批准', 'audit.view': '审计追踪查看',
};

function permissionLabel(perm) {
  return PERMISSION_LABELS[perm] || perm;
}

// ------------------------------------------------------------ workflow ------

/**
 * Single workflow page: full step chain ("责任移交链"), each step's roles and
 * their permissions, signature gates, constraints and the three-state matrix.
 */
function getWorkflow(processCode) {
  const def = workflow.getDefinition(String(processCode));
  if (!def) return null;
  const roles = new Set();
  for (const step of def.steps || []) {
    const list = Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []);
    for (const r of list) roles.add(r);
  }
  const roleList = [...roles].filter((r) => rbac.ROLES[r]);
  const stepRoles = {};
  for (const step of def.steps || []) {
    stepRoles[step.code] = (Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []))
      .filter((r) => rbac.ROLES[r]);
  }

  // 责任移交链：who hands what to whom.
  const chain = (def.steps || []).map((step, idx) => {
    const previousRoles = idx > 0 ? stepRoles[(def.steps[idx - 1]).code] : [];
    return {
      code: step.code,
      seq: idx + 1,
      name: step.name,
      nameEn: step.nameEn,
      type: step.type || 'task',
      signatureMeaning: step.signatureMeaning || null,
      independentOfAuthor: Boolean(step.independentOfAuthor),
      requiresFields: step.requiresFields || [],
      roles: stepRoles[step.code] || [],
      roleLabels: (stepRoles[step.code] || []).map((r) => (rbac.ROLES[r] || {}).labelZh || r),
      handoverFrom: previousRoles.map((r) => (rbac.ROLES[r] || {}).labelZh || r),
      guidance: step.guidance || null,
      onComplete: step.onComplete || null,
      persistFields: step.persistFields || null,
      form: step.form || [],
    };
  });

  const matrix = permissionMatrix(roleList, domainPermissionsFor(def.gxpAreas[0] || 'RSD'));

  return {
    code: def.code,
    name: def.name,
    nameEn: def.nameEn,
    category: def.category,
    gxpAreas: def.gxpAreas || [],
    description: def.description,
    descriptionEn: def.descriptionEn,
    slaDays: def.slaDays,
    requiresQaApproval: def.requiresQaApproval,
    criticalityLevels: def.criticalityLevels || [],
    regulationRefs: def.regulationRefs || [],
    states: def.states || [],
    initialState: def.initialState,
    terminalStates: def.terminalStates || [],
    fields: def.fields || [],
    chain,
    participants: roleList.map((r) => {
      const d = rbac.ROLES[r];
      return {
        role: r, label: d.labelZh, labelEn: d.label,
        description: d.description,
        stepsHeld: (def.steps || []).filter((s) => {
          const list = Array.isArray(s.role) ? s.role : (s.role ? [s.role] : []);
          return list.includes(r);
        }).map((s) => s.name),
        signatureMeanings: signatureMeaningsForRole(r),
        permissions: rbac.permissionsFor(r),
      };
    }),
    matrix,
    constraints: constraints.CONSTRAINTS.map((c) => ({
      code: c.code, name: c.name, description: c.description,
      basis: c.basis, enforced: c.enforced, effect: c.effect,
    })),
    recordStats: recordStatsFor(processCode),
  };
}

function recordStatsFor(processCode) {
  const rows = db.all(
    `SELECT status, COUNT(*) AS n FROM workflow_instances WHERE process_code = ? GROUP BY status`,
    [processCode]
  );
  const total = rows.reduce((a, r) => a + r.n, 0);
  const open = rows.filter((r) => !['closed', 'cancelled', 'rejected'].includes(r.status)).reduce((a, r) => a + r.n, 0);
  return { total, open, byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])) };
}

/** All workflows with their participant roles (for the explorer overview). */
function workflowOverview() {
  return workflow.listProcessTypes().map((p) => ({
    code: p.code, name: p.name, nameEn: p.nameEn, category: p.category,
    gxpAreas: p.gxpAreas, slaDays: p.slaDays, stepCount: p.stepCount,
    description: p.description,
    participants: (p.steps || []).flatMap((s) => (Array.isArray(s.role) ? s.role : (s.role ? [s.role] : [])))
      .filter((r, i, arr) => r && arr.indexOf(r) === i),
  }));
}

module.exports = {
  listDomains,
  getDomain,
  getWorkflow,
  workflowOverview,
  permissionMatrix,
  permissionLabel,
  PHILOSOPHY,
};