'use strict';

/**
 * Built-in personas for a click-and-use instance.
 *
 * WHY THIS EXISTS
 * ---------------
 * A workbench whose value comes from role separation is useless on first launch
 * if the user has to invent a dozen accounts before they can see any of it.
 * This module defines a small cast of pharmacoeconomics roles that between them
 * exercise every distinctive part of the system - drafter, modeler, statistician,
 * QA, external reviewer - so the role gates and the inbox can be demonstrated.
 *
 * SAFETY
 * ------
 * Provisioning is opt-in and off by default:
 *
 *   PE_BUILTIN_ACCOUNTS=1   create/refresh the personas at start-up
 *
 * A production instance must never be shipped with known credentials. Every
 * account is a real row in `users`, so RBAC, signature gates and the audit
 * trail treat them exactly like human-created accounts.
 */

const config = require('../config');
const db = require('../core/db');
const auth = require('../core/auth');
const crypto = require('../core/crypto');
const audit = require('../core/audit');
const visibility = require('./visibility');

/** The single credential every built-in persona shares (demo only). */
const BUILTIN_PASSWORD = 'PE-Demo-2026!';

/**
 * The cast - one persona per capability boundary a new user needs to *see*
 * to understand the workbench: who drafts, who models, who approves, who QA's.
 */
const PERSONAS = [
  {
    username: 'demo.heorlead',
    fullName: '王建国',
    fullNameEn: 'Wang Jianguo',
    role: 'heor_lead',
    department: '药物经济学部',
    jobTitle: 'HEOR 负责人 / 首席药物经济学家',
    gxpAreas: ['RSD', 'EVS', 'OUT', 'CST', 'MDL', 'ANA', 'RPT'],
    qualification: { healthEcon: true },
    blurb: 'HEOR 负责人：批准方案、模型与报告，是经济学结论的最终签字人。',
    blurbEn: 'HEOR Lead: approves protocols, models and reports; final signer of economic conclusions.',
    highlight: '看审批链如何汇聚到这个人',
  },
  {
    username: 'demo.researcher',
    fullName: '李慧',
    fullNameEn: 'Li Hui',
    role: 'heor_researcher',
    department: '药物经济学部',
    jobTitle: '药物经济学研究员',
    gxpAreas: ['RSD', 'EVS', 'OUT', 'CST', 'ANA', 'RPT'],
    qualification: { healthEcon: true },
    blurb: '研究员：起草方案与报告、做成本与效用分析、算 ICER。',
    blurbEn: 'Researcher: drafts protocols and reports, runs cost and utility analyses, computes ICER.',
    highlight: '最常见的执行者视角',
  },
  {
    username: 'demo.modeler',
    fullName: '张帆',
    fullNameEn: 'Zhang Fan',
    role: 'modeler',
    department: '药物经济学部',
    jobTitle: '建模分析师',
    gxpAreas: ['MDL', 'ANA', 'CST', 'OUT'],
    qualification: { modeling: true },
    blurb: '建模分析师：搭建 Markov/分区生存模型、维护版本、做内部验证。',
    blurbEn: 'Modeling analyst: builds Markov / partitioned-survival models, maintains versions, runs internal validation.',
    highlight: '看模型开发的八步受控流程',
  },
  {
    username: 'demo.evidence',
    fullName: '陈露',
    fullNameEn: 'Chen Lu',
    role: 'evidence_specialist',
    department: '医学证据部',
    jobTitle: '证据综述研究员',
    gxpAreas: ['EVS', 'RSD'],
    qualification: { slr: true },
    blurb: '证据综述研究员：系统文献综述、间接比较、证据综合。',
    blurbEn: 'Evidence specialist: systematic literature reviews and indirect comparisons.',
    highlight: 'SLR 七步流程与检索先行规则',
  },
  {
    username: 'demo.stat',
    fullName: '刘敏',
    fullNameEn: 'Liu Min',
    role: 'biostatistician',
    department: '生物统计部',
    jobTitle: '生物统计师',
    gxpAreas: ['EVS', 'MDL', 'ANA'],
    qualification: { stats: true },
    blurb: '生物统计师：NMA 分析、一致性检验、模型验证与不确定性分析。',
    blurbEn: 'Biostatistician: NMA, consistency checks, model verification, uncertainty analysis.',
    highlight: '统计闸门与一致性检验的独立性',
  },
  {
    username: 'demo.clinical',
    fullName: '徐志明',
    fullNameEn: 'Xu Zhiming',
    role: 'clinical_advisor',
    department: '医学事务部',
    jobTitle: '临床顾问（主任医师）',
    gxpAreas: ['RSD', 'OUT', 'MDL', 'ANA'],
    qualification: { clinical: true },
    blurb: '临床顾问：从疾病自然史角度审阅模型结构与结局合理性。',
    blurbEn: 'Clinical advisor: reviews model structure and outcome plausibility against disease natural history.',
    highlight: '临床合理性是模型的另一双眼睛',
  },
  {
    username: 'demo.hta',
    fullName: '赵雯',
    fullNameEn: 'Zhao Wen',
    role: 'hta_officer',
    department: '准入事务部',
    jobTitle: 'HTA / 医保申报专员',
    gxpAreas: ['RPT', 'ANA'],
    qualification: { hta: true },
    blurb: '申报专员：负责对 HTA 机构、医保谈判、期刊的提交。',
    blurbEn: 'HTA officer: owns submissions to HTA bodies, reimbursement negotiations and journals.',
    highlight: '提交动作本身签名留痕',
  },
  {
    username: 'demo.qa',
    fullName: '周琳',
    fullNameEn: 'Zhou Lin',
    role: 'heor_qa',
    department: '质量保证部',
    jobTitle: 'HEOR 质量保证专员',
    gxpAreas: ['RSD', 'EVS', 'OUT', 'CST', 'MDL', 'ANA', 'RPT'],
    qualification: { qa: true },
    blurb: 'HEOR QA：独立核查报告（CHEERS）、关闭数据问题、外审模型。',
    blurbEn: 'HEOR QA: independent CHEERS checks, closes data issues, externally reviews models.',
    highlight: '独立性原则：发起人不能自己关闭',
  },
  {
    username: 'demo.data',
    fullName: '吴凯',
    fullNameEn: 'Wu Kai',
    role: 'data_manager',
    department: '数据管理部',
    jobTitle: '数据管理员',
    gxpAreas: ['CST', 'OUT', 'EVS'],
    qualification: { data: true },
    blurb: '数据管理员：保管原始数据与费用目录，发起数据问题。',
    blurbEn: 'Data manager: custodian of raw data and cost catalogues; raises data issues.',
    highlight: '数据完整性的第一道哨兵',
  },
  {
    username: 'demo.coordinator',
    fullName: '孙悦',
    fullNameEn: 'Sun Yue',
    role: 'coordinator',
    department: '项目运营部',
    jobTitle: '项目协调员',
    gxpAreas: ['RSD', 'RPT'],
    blurb: '协调员：项目排期、会议与文档流转，只读大部分分析内容。',
    blurbEn: 'Coordinator: scheduling, logistics and document flow; read-only for most analysis content.',
    highlight: '看看「看不了」的权限边界',
  },
  {
    username: 'demo.external',
    fullName: 'Prof. Sarah Miller',
    fullNameEn: 'Sarah Miller',
    role: 'auditor_external',
    department: '外部专家',
    jobTitle: '外部评审专家（限时）',
    gxpAreas: ['RSD', 'EVS', 'OUT', 'CST', 'MDL', 'ANA', 'RPT'],
    qualification: {},
    blurb: '外部评审专家：只读、限时访问，每一次查看都被审计。',
    blurbEn: 'External reviewer: read-only, time-boxed access; every view is audited.',
    highlight: '限时访问到期自动失效',
  },
];

/** The single credential every built-in persona shares. */
function builtinAccountsEnabled() {
  return config.features.builtinAccounts;
}

function personaByUsername(username) {
  return PERSONAS.find((p) => p.username === username) || null;
}

function passwordCandidates() {
  if (!builtinAccountsEnabled()) return [];
  return [BUILTIN_PASSWORD];
}

function passwordHint() {
  return BUILTIN_PASSWORD;
}

/**
 * Provision (create or refresh) the persona cast. Idempotent.
 */
function provision(adminUser, ctx) {
  const enabled = builtinAccountsEnabled();
  const summary = { enabled, created: 0, refreshed: 0 };
  if (!enabled) return summary;
  for (const persona of PERSONAS) {
    sum(summary, ensurePersona(persona, ctx, adminUser));
  }
  return summary;
}

function sum(into, added) {
  into.created += added.created;
  into.refreshed += added.refreshed;
}

function ensurePersona(persona, ctx, adminUser) {
  const existing = db.get('SELECT * FROM users WHERE username = ?', [persona.username]);
  const now = new Date().toISOString();
  const created = !existing ? 1 : 0;
  if (existing && existing.status === 'active') {
    return { created: 0, refreshed: 0 };
  }
  const h = crypto.hashPassword(BUILTIN_PASSWORD);
  if (existing) {
    db.run(
      'UPDATE users SET full_name = ?, full_name_en = ?, role = ?, department = ?, job_title = ?, ' +
      'gxp_areas = ?, password_hash = ?, password_algo = ?, password_salt = ?, status = ?, ' +
      'qualification = ?, updated_at = ? WHERE id = ?',
      [persona.fullName, persona.fullNameEn || null, persona.role, persona.department || null,
        persona.jobTitle || null, JSON.stringify(persona.gxpAreas || []),
        h.hash, h.algo, h.salt, 'active',
        JSON.stringify(persona.qualification || {}), now, existing.id]
    );
    audit.append({
      action: 'account_refreshed', entityType: 'users', entityId: existing.id,
      recordKey: `users:${existing.id}`, actor: adminUser || null,
      reason: `Built-in persona ${persona.username} refreshed`, ctx,
      meta: { role: persona.role },
    });
    return { created: 0, refreshed: 1 };
  }
  const res = db.run(
    'INSERT INTO users (username, full_name, full_name_en, email, department, job_title, role, status, ' +
    'password_hash, password_algo, password_salt, password_changed_at, must_change_password, locale, ' +
    'gxp_areas, qualification, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [persona.username, persona.fullName, persona.fullNameEn || null, null,
      persona.department || null, persona.jobTitle || null, persona.role, 'active',
      h.hash, h.algo, h.salt, now, 0, 'zh-CN',
      JSON.stringify(persona.gxpAreas || []), JSON.stringify(persona.qualification || {}), now, now,
      adminUser ? adminUser.id : null]
  );
  const id = db.get('SELECT last_insert_rowid() AS id').id;
  audit.append({
    action: 'account_provisioned', entityType: 'users', entityId: id,
    recordKey: `users:${id}`, actor: adminUser || null,
    reason: `Built-in persona ${persona.username} (${persona.role}) created`, ctx,
    meta: { role: persona.role, areas: persona.gxpAreas || [] },
  });
  return { created: 1, refreshed: 0 };
}

/** Choices for the identity picker (only when built-in accounts are enabled). */
function loginChoices() {
  if (!builtinAccountsEnabled()) return [];
  return PERSONAS.map((p) => {
    const row = db.get('SELECT * FROM users WHERE username = ?', [p.username]);
    return {
      username: p.username,
      fullName: p.fullName,
      fullNameEn: p.fullNameEn,
      role: p.role,
      roleLabel: (require('../core/rbac').ROLES[p.role] || {}).labelZh || p.role,
      department: p.department,
      jobTitle: p.jobTitle,
      areas: p.gxpAreas || [],
      blurb: p.blurb,
      blurbEn: p.blurbEn,
      highlight: p.highlight,
      id: row ? row.id : null,
    };
  });
}

/** Domains that a built-in persona can enter, derived from its registered areas. */
function loginDomains() {
  const areas = new Set();
  for (const p of PERSONAS) for (const a of p.gxpAreas || []) areas.add(a);
  return db.all('SELECT * FROM gxp_areas ORDER BY sort_order').filter((a) => areas.has(a.code));
}

/** Roles that work in each area (identity card list per domain). */
function rolesByArea() {
  const out = {};
  const roleAreas = visibility.HOME_AREAS_BY_ROLE;
  for (const [role, areas] of Object.entries(roleAreas)) {
    for (const area of areas) {
      (out[area] = out[area] || []).push(role);
    }
  }
  return out;
}

/**
 * How many workflow steps each role holds in each area (used to sort identity
 * cards by how much that role actually does in the domain).
 */
function areaStepCounts() {
  const counts = {};
  const rows = db.all(
    `SELECT code, gxp_areas, definitions_json FROM process_types WHERE active = 1`
  );
  for (const row of rows) {
    let def = null;
    try { def = JSON.parse(row.definitions_json); } catch { continue; }
    const areas = JSON.parse(row.gxp_areas || '[]');
    for (const step of def.steps || []) {
      const roles = Array.isArray(step.role) ? step.role : [step.role];
      for (const role of roles) {
        if (!role) continue;
        for (const area of areas) {
          counts[`${area}:${role}`] = (counts[`${area}:${role}`] || 0) + 1;
        }
      }
    }
  }
  return counts;
}

function homeAreasByRole() {
  return visibility.homeAreasByRole();
}

module.exports = {
  PERSONAS,
  BUILTIN_PASSWORD,
  builtinAccountsEnabled,
  provision,
  loginChoices,
  loginDomains,
  rolesByArea,
  areaStepCounts,
  homeAreasByRole,
  passwordHint,
  passwordCandidates,
  ensurePersona,
  personaByUsername,
};