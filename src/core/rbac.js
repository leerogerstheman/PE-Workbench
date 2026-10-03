'use strict';

/**
 * Role based access control for the PharmacoEconomics Workbench.
 *
 * Separation of duties is the core of defensible pharmacoeconomic work
 * (parallel to EU GMP Annex 11 §12.1 / ICH Q10, and REQUIRED by the reporting
 * standards themselves): the person who builds a model must not be the only
 * person who validates it, the person who drafts a report must not be the only
 * person who approves it, and the person who discovers a data issue must not
 * be the one who closes it.
 *
 * `*` means "all permissions" and is intentionally granted only to
 * `system_admin`, whose analysis-record access is additionally restricted by
 * the rule that system administrators may not serve as the sole approver of
 * analysis records (see `canSign`).
 */

const PERMISSIONS = {
  // administration
  USER_VIEW: 'user.view',
  USER_MANAGE: 'user.manage',
  ROLE_MANAGE: 'role.manage',
  POLICY_MANAGE: 'policy.manage',
  SETTINGS_MANAGE: 'settings.manage',
  BACKUP_MANAGE: 'backup.manage',
  EXPLORER_MANAGE: 'explorer.manage',

  // audit / integrity
  AUDIT_VIEW: 'audit.view',
  AUDIT_VERIFY: 'audit.verify',
  AUDIT_EXPORT: 'audit.export',
  SIGNATURE_AUTHORIZE: 'signature.authorize',
  COMPLIANCE_VIEW: 'compliance.view',
  COMPLIANCE_MANAGE: 'compliance.manage',

  // document control (protocols, reports, evidence dossiers, SOPs)
  DOC_VIEW: 'doc.view',
  DOC_CREATE: 'doc.create',
  DOC_EDIT: 'doc.edit',
  DOC_REVIEW: 'doc.review',
  DOC_APPROVE: 'doc.approve',
  DOC_OBSOLETE: 'doc.obsolete',

  // workflow records (all process types share these)
  RECORD_VIEW: 'record.view',
  RECORD_CREATE: 'record.create',
  RECORD_EDIT: 'record.edit',
  RECORD_CLOSE: 'record.close',
  RECORD_DELETE: 'record.delete',
  RECORD_EXPORT: 'record.export',

  // pharmacoeconomics domain capabilities
  PROTOCOL_MANAGE: 'protocol.manage',       // 研究方案与健康经济学分析计划 (HEAP)
  EVIDENCE_MANAGE: 'evidence.manage',       // 系统文献综述 SLR
  ITC_MANAGE: 'itc.manage',                 // 间接比较 / 网络荟萃分析 NMA
  UTILITY_MANAGE: 'utility.manage',         // 效用与健康结局（EQ-5D 等）
  COST_MANAGE: 'cost.manage',               // 成本测算
  MODEL_MANAGE: 'model.manage',             // 经济模型开发
  MODEL_VALIDATE: 'model.validate',         // 模型验证（ISPOR-SMDM 七问）
  MODEL_PUBLISH: 'model.publish',           // 模型版本发布
  BIA_MANAGE: 'bia.manage',                 // 预算影响分析
  ANALYSIS_MANAGE: 'analysis.manage',       // 分析与解读（ICER / 阈值 / 敏感性）
  REPORT_MANAGE: 'report.manage',           // 经济评估报告
  CHEERS_MANAGE: 'cheers.manage',           // 报告规范核查（CHEERS 2022 / 中国指南）
  SUBMISSION_MANAGE: 'submission.manage',   // HTA / 医保 / 期刊申报
  DATAISSUE_MANAGE: 'dataissue.manage',     // 数据完整性问题
  CHANGE_MANAGE: 'change.manage',           // 变更控制（模型/方法/参数）

  // training & qualification
  TRAINING_VIEW: 'training.view',
  TRAINING_MANAGE: 'training.manage',
  TRAINING_ASSESS: 'training.assess',

  // self-assessment / internal review
  INSPECTION_VIEW: 'inspection.view',
  INSPECTION_MANAGE: 'inspection.manage',
  INSPECTION_REPORT: 'inspection.report',
};

const P = PERMISSIONS;

const READ_ONLY = [
  P.DOC_VIEW, P.RECORD_VIEW, P.AUDIT_VIEW, P.TRAINING_VIEW, P.INSPECTION_VIEW,
  P.COMPLIANCE_VIEW,
];

const ROLES = {
  system_admin: {
    label: 'System Administrator',
    labelZh: '系统管理员',
    description: 'Technical administration of users, roles and configuration. Cannot be the sole approver of analysis records.',
    permissions: ['*'],
    isRecordParty: false,
  },

  heor_lead: {
    label: 'HEOR Lead / Chief Pharmacoeconomist',
    labelZh: 'HEOR 负责人 / 首席药物经济学家',
    description: 'Owns the pharmacoeconomic evidence programme: approves protocols, models, reports and submissions.',
    permissions: [
      ...READ_ONLY,
      P.USER_VIEW, P.AUDIT_VERIFY, P.AUDIT_EXPORT, P.SIGNATURE_AUTHORIZE, P.COMPLIANCE_MANAGE,
      P.EXPLORER_MANAGE,
      P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW, P.DOC_APPROVE, P.DOC_OBSOLETE,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_CLOSE, P.RECORD_EXPORT,
      P.PROTOCOL_MANAGE, P.EVIDENCE_MANAGE, P.ITC_MANAGE, P.UTILITY_MANAGE, P.COST_MANAGE,
      P.MODEL_MANAGE, P.MODEL_VALIDATE, P.MODEL_PUBLISH, P.BIA_MANAGE, P.ANALYSIS_MANAGE,
      P.REPORT_MANAGE, P.CHEERS_MANAGE, P.SUBMISSION_MANAGE, P.DATAISSUE_MANAGE, P.CHANGE_MANAGE,
      P.TRAINING_MANAGE, P.TRAINING_ASSESS,
      P.INSPECTION_MANAGE, P.INSPECTION_REPORT,
    ],
    isRecordParty: true,
  },

  heor_researcher: {
    label: 'Pharmacoeconomics Researcher',
    labelZh: '药物经济学研究员',
    description: 'Runs analyses: protocols, costings, outcomes, ICER tables, draft reports.',
    permissions: [
      ...READ_ONLY,
      P.COMPLIANCE_MANAGE,
      P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
      P.PROTOCOL_MANAGE, P.EVIDENCE_MANAGE, P.UTILITY_MANAGE, P.COST_MANAGE,
      P.BIA_MANAGE, P.ANALYSIS_MANAGE, P.REPORT_MANAGE, P.CHEERS_MANAGE,
      P.DATAISSUE_MANAGE, P.CHANGE_MANAGE,
      P.TRAINING_MANAGE,
    ],
    isRecordParty: true,
  },

  modeler: {
    label: 'Modeling Analyst',
    labelZh: '建模分析师',
    description: 'Builds and codes decision-tree / Markov / partitioned-survival models; maintains versions.',
    permissions: [
      ...READ_ONLY,
      P.DOC_REVIEW, P.DOC_CREATE, P.DOC_EDIT,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
      P.MODEL_MANAGE, P.MODEL_VALIDATE, P.UTILITY_MANAGE, P.COST_MANAGE,
      P.ANALYSIS_MANAGE, P.DATAISSUE_MANAGE, P.CHANGE_MANAGE,
      P.TRAINING_VIEW, P.INSPECTION_VIEW,
    ],
    isRecordParty: true,
  },

  evidence_specialist: {
    label: 'Evidence Review Specialist',
    labelZh: '证据综述研究员',
    description: 'Owns systematic literature reviews (SLR), screening, data extraction and evidence synthesis.',
    permissions: [
      ...READ_ONLY,
      P.DOC_REVIEW, P.DOC_CREATE, P.DOC_EDIT,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
      P.EVIDENCE_MANAGE, P.ITC_MANAGE, P.UTILITY_MANAGE,
      P.REPORT_MANAGE, P.DATAISSUE_MANAGE,
      P.TRAINING_VIEW, P.INSPECTION_VIEW,
    ],
    isRecordParty: true,
  },

  biostatistician: {
    label: 'Biostatistician',
    labelZh: '生物统计师',
    description: 'Statistical review of ITC/NMA, model verification, PSA and uncertainty analyses.',
    permissions: [
      ...READ_ONLY,
      P.DOC_REVIEW,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
      P.ITC_MANAGE, P.MODEL_VALIDATE, P.ANALYSIS_MANAGE,
      P.BIA_MANAGE, P.DATAISSUE_MANAGE, P.CHANGE_MANAGE,
      P.TRAINING_VIEW, P.INSPECTION_VIEW,
    ],
    isRecordParty: true,
  },

  clinical_advisor: {
    label: 'Clinical Advisor',
    labelZh: '临床顾问',
    description: 'Independent clinical plausibility review of comparators, outcomes and model structure.',
    permissions: [
      ...READ_ONLY,
      P.DOC_REVIEW,
      P.RECORD_VIEW, P.RECORD_EXPORT,
      P.UTILITY_MANAGE, P.ANALYSIS_MANAGE,
      P.TRAINING_VIEW, P.INSPECTION_VIEW,
    ],
    isRecordParty: true,
  },

  hta_officer: {
    label: 'HTA / Reimbursement Officer',
    labelZh: 'HTA / 医保申报专员',
    description: 'Prepares and submits dossiers to HTA bodies, payers and journals; owns submission artefacts.',
    permissions: [
      ...READ_ONLY,
      P.AUDIT_EXPORT, P.COMPLIANCE_MANAGE,
      P.DOC_CREATE, P.DOC_EDIT,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
      P.REPORT_MANAGE, P.CHEERS_MANAGE, P.SUBMISSION_MANAGE, P.BIA_MANAGE,
      P.CHANGE_MANAGE,
      P.TRAINING_VIEW, P.INSPECTION_VIEW,
    ],
    isRecordParty: true,
  },

  heor_qa: {
    label: 'HEOR Quality Assurance',
    labelZh: 'HEOR 质量保证专员',
    description: 'Independent QA: checklist assessments (CHEERS/China guideline), data issue closure, internal review.',
    permissions: [
      ...READ_ONLY,
      P.AUDIT_VERIFY, P.AUDIT_EXPORT, P.COMPLIANCE_MANAGE,
      P.DOC_REVIEW, P.DOC_APPROVE,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_CLOSE, P.RECORD_EXPORT,
      P.CHEERS_MANAGE, P.DATAISSUE_MANAGE, P.CHANGE_MANAGE, P.MODEL_VALIDATE,
      P.PROTOCOL_MANAGE, P.REPORT_MANAGE, P.ANALYSIS_MANAGE,
      P.TRAINING_MANAGE, P.TRAINING_ASSESS,
      P.INSPECTION_MANAGE, P.INSPECTION_REPORT,
    ],
    isRecordParty: true,
  },

  data_manager: {
    label: 'Data Manager',
    labelZh: '数据管理员',
    description: 'Custody of raw data files, cost catalogues and study datasets; flags data issues.',
    permissions: [
      ...READ_ONLY,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
      P.COST_MANAGE, P.UTILITY_MANAGE, P.DATAISSUE_MANAGE,
      P.TRAINING_VIEW, P.INSPECTION_VIEW,
    ],
    isRecordParty: true,
  },

  coordinator: {
    label: 'Project Coordinator',
    labelZh: '项目协调员',
    description: 'Scheduling, participant logistics and documentation logistics for the analysis programme.',
    permissions: [
      P.DOC_VIEW, P.RECORD_VIEW, P.TRAINING_VIEW, P.INSPECTION_VIEW,
      P.RECORD_CREATE, P.RECORD_EDIT,
      P.USER_VIEW,
    ],
    isRecordParty: false,
  },

  auditor_external: {
    label: 'External Reviewer / Inspector (read-only)',
    labelZh: '外部评审专家（只读）',
    description: 'Time-boxed read-only access for external peer review or inspection; every view is audited.',
    permissions: [
      P.DOC_VIEW, P.RECORD_VIEW, P.AUDIT_VIEW, P.TRAINING_VIEW, P.INSPECTION_VIEW,
      P.COMPLIANCE_VIEW, P.AUDIT_EXPORT,
    ],
    isRecordParty: false,
    readOnly: true,
  },

  viewer: {
    label: 'Viewer',
    labelZh: '只读用户',
    description: 'General read-only access for awareness.',
    permissions: READ_ONLY,
    isRecordParty: false,
    readOnly: true,
  },
};

/** Expand `*` and de-duplicate. */
function permissionsFor(role) {
  const def = ROLES[role];
  if (!def) return [];
  if (def.permissions.includes('*')) return ['*'];
  return [...new Set(def.permissions)];
}

function hasPermission(user, permission) {
  if (!user) return false;
  const perms = permissionsFor(user.role);
  return perms.includes('*') || perms.includes(permission);
}

function hasAny(user, permissions) {
  return permissions.some((p) => hasPermission(user, p));
}

const WRITE_ACTIONS = new Set([
  P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW, P.DOC_APPROVE, P.DOC_OBSOLETE,
  P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_CLOSE, P.RECORD_DELETE,
  P.PROTOCOL_MANAGE, P.EVIDENCE_MANAGE, P.ITC_MANAGE, P.UTILITY_MANAGE,
  P.COST_MANAGE, P.MODEL_MANAGE, P.MODEL_VALIDATE, P.MODEL_PUBLISH,
  P.BIA_MANAGE, P.ANALYSIS_MANAGE, P.REPORT_MANAGE, P.CHEERS_MANAGE,
  P.SUBMISSION_MANAGE, P.DATAISSUE_MANAGE, P.CHANGE_MANAGE,
  P.USER_MANAGE, P.POLICY_MANAGE, P.SETTINGS_MANAGE, P.BACKUP_MANAGE,
  P.INSPECTION_MANAGE, P.TRAINING_MANAGE,
]);

function isReadOnly(user) {
  if (!user) return true;
  const def = ROLES[user.role];
  if (def && def.readOnly) return true;
  return !permissionsFor(user.role).some((p) => p === '*' || WRITE_ACTIONS.has(p));
}

/**
 * Whether this user may apply an e-signature to a record.
 * Enforces: active account, signature permission, not the record's own author
 * when the step demands independence, and no self-approval by system admins.
 */
function canSign(user, record, opts = {}) {
  if (!user || user.status !== 'active') return { ok: false, code: 'ACCOUNT_NOT_ACTIVE' };
  if (!hasPermission(user, PERMISSIONS.SIGNATURE_AUTHORIZE)
      && !permissionsFor(user.role).includes('*')
      && !hasAny(user, [P.RECORD_CLOSE, P.RECORD_EDIT, P.DOC_APPROVE, P.MODEL_PUBLISH])) {
    return { ok: false, code: 'NO_SIGNATURE_PERMISSION' };
  }
  if (record && opts.requireIndependence) {
    const authorId = record.created_by || record.reported_by;
    if (authorId && authorId === user.id) {
      return { ok: false, code: 'INDEPENDENCE_VIOLATION', message: 'Signer must be independent of the record author.' };
    }
  }
  if (user.role === 'system_admin' && opts.requireQualityRole) {
    return { ok: false, code: 'ADMIN_CANNOT_APPROVE', message: 'System administrator accounts may not serve as the sole approver of analysis records.' };
  }
  return { ok: true };
}

function listRoles() {
  return Object.entries(ROLES).map(([code, def]) => ({
    code,
    label: def.label,
    labelZh: def.labelZh,
    description: def.description,
    readOnly: Boolean(def.readOnly),
    isRecordParty: def.isRecordParty,
    permissionCount: permissionsFor(code).length,
    permissions: permissionsFor(code),
  }));
}

module.exports = {
  PERMISSIONS,
  ROLES,
  permissionsFor,
  hasPermission,
  hasAny,
  isReadOnly,
  canSign,
  listRoles,
};