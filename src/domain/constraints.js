'use strict';

/**
 * Code-enforced constraints catalogue.
 *
 * WHY THIS EXISTS
 * ---------------
 * A permission matrix that only shows "allowed / not allowed" is misleading when
 * the system also refuses actions for reasons that have nothing to do with the
 * permission set. The HEOR 负责人 holds `record.close` - yet the kernel will
 * still refuse to let them close a record they authored, because separation of
 * duties forbids it. If the matrix says "you may close records" and the button
 * then fails, the interface has lied to the user and undermined their trust in
 * every other claim the system makes.
 *
 * So every constraint that is enforced *in code*, independently of the role
 * configuration, is catalogued here and surfaced as a third state in the matrix:
 * ALLOWED / DENIED / CONDITIONAL (with the reason and the methodological basis).
 *
 * The methodological anchors are pharmacoeconomic ones: CHEERS 2022 (transparent
 * reporting), 中国药物经济学评价指南（2020）(第 12 章报告规范), ISPOR-SMDM modelling
 * good practices, plus the data-integrity discipline (ALCOA+) that the GxP
 * world and the analysis world now share.
 */

const CONSTRAINTS = [
  {
    code: 'AUTHOR_CANNOT_CLOSE',
    name: '记录作者不能关闭自己的记录',
    nameEn: 'Record author cannot close their own record',
    description: '步骤声明 independentOfAuthor 时，服务端拒绝记录作者本人完成该步骤（签名与关闭都不行）。分析工作的关闭结论必须由独立于起草者的人作出。',
    descriptionEn: 'When a step declares independentOfAuthor, the kernel refuses to let the record author complete it, including signing the closure.',
    basis: 'CHEERS 2022 第 22-23 项（结果须经受独立核查）；数据完整性原则；ICH Q10 / EU GMP Annex 11 §12.1 职责分离',
    enforced: 'src/domain/workflow.js · completeStep（INDEPENDENCE_VIOLATION）',
    effect: 'conditional',
    permissions: ['record.close', 'model.publish'],
  },
  {
    code: 'ADMIN_CANNOT_APPROVE',
    name: '系统管理员不能作为分析记录的唯一批准人',
    nameEn: 'System administrator cannot be the sole approver',
    description: '管理员维护用户与配置，但其账号在质量角色批准场景下被明确拒绝——技术访问权不等于方法学判断权。',
    descriptionEn: 'The system administrator may not serve as the sole approver of analysis records.',
    basis: '职责分离（ICH Q10 / Annex 11 §12.1 的精神）；报告可信度',
    enforced: 'src/core/rbac.js · canSign（ADMIN_CANNOT_APPROVE）',
    effect: 'conditional',
    permissions: ['record.close', 'model.publish', 'doc.approve'],
  },
  {
    code: 'STEP_ROLE_GATE',
    name: '步骤只接受声明的角色',
    nameEn: 'Steps accept only declared roles',
    description: '工作流的每一步声明允许的角色清单，其他角色即使持有通用记录权限也被拒绝，并说明该步骤要求的角色。',
    descriptionEn: 'Each workflow step declares its allowed roles; other roles are refused with the required role list in the message.',
    basis: '流程定义即承诺（配置驱动工作流）',
    enforced: 'src/domain/workflow.js · completeStep（ROLE_NOT_PERMITTED）',
    effect: 'conditional',
    permissions: ['record.edit', 'record.close'],
  },
  {
    code: 'SIGNATURE_TWO_FACTOR',
    name: '电子签名必须使用两个独立要素',
    nameEn: 'E-signatures need two distinct components',
    description: '签署时重新输入识别码与密码（分量 A），并验证 TOTP 动态口令或一次性挑战码（分量 B）。已登录会话本身不构成签名要素。',
    descriptionEn: 'Signing re-requires the identification code and password plus a second factor (TOTP or one-time challenge).',
    basis: '21 CFR Part 11.200(a)(1)(i)；数据完整性',
    enforced: 'src/core/auth.js · sign（SECOND_FACTOR_REQUIRED）',
    effect: 'conditional',
    permissions: ['signature.authorize', 'record.close'],
  },
  {
    code: 'REASON_REQUIRED',
    name: '所有记录变更必须填写理由',
    nameEn: 'Every record change requires a stated reason',
    description: '对任何分析记录的修改、链接、取消都必须提供理由（至少 3 字），取消记录至少 10 字。没有理由的修改在审计中不可辩护。',
    descriptionEn: 'Every mutation of an analysis record requires a stated reason; cancelling requires at least 10 characters.',
    basis: 'ALCOA+（Attributable, Legible, ...）；21 CFR Part 11.10(e)',
    enforced: 'src/domain/workflow.js · updateInstance / cancelInstance',
    effect: 'conditional',
    permissions: ['record.edit', 'record.close'],
  },
  {
    code: 'TERMINAL_READONLY',
    name: '已关闭记录只读',
    nameEn: 'Closed records are read-only',
    description: '处于终态（closed/cancelled/rejected）的记录不可再修改。需要变更时新建一条链接记录（变更控制），原记录保持原样。',
    descriptionEn: 'Terminal records are immutable; changes go through a new linked record.',
    basis: 'ALCOA+（Enduring）；报告可追溯性',
    enforced: 'src/domain/workflow.js · updateInstance / completeStep（RECORD_TERMINAL）',
    effect: 'conditional',
    permissions: ['record.edit', 'record.close'],
  },
  {
    code: 'NEGATIVE_FINDING_EVIDENCE',
    name: '负面判定必须提供客观证据',
    nameEn: 'Negative assessments require objective evidence',
    description: '将检查表条目判定为"部分符合"或"存在缺陷"时，必须提供至少 10 个字的客观证据；无证据的负面判定在核查中不可辩护。',
    descriptionEn: 'Assessing an item as partial or gap requires objective evidence of at least 10 characters.',
    basis: 'CHEERS 2022 第 23 项（不确定性如实报告）；数据完整性',
    enforced: 'src/domain/inspections.js · assessItem（EVIDENCE_REQUIRED）',
    effect: 'conditional',
    permissions: ['cheers.manage', 'inspection.manage'],
  },
  {
    code: 'AUDIT_APPEND_ONLY',
    name: '审计追踪只可追加',
    nameEn: 'Audit trail is append-only',
    description: '审计表禁止 UPDATE 与 DELETE（SQLite 触发器拦截），哈希链校验可定位到具体断点；绕过数据库的篡改也会被摘要比对发现。',
    descriptionEn: 'The audit trail is append-only with a keyed hash chain; tampering is detectable down to the exact row.',
    basis: '21 CFR Part 11.10(e)；ALCOA+',
    enforced: 'src/core/db.js（触发器）· src/core/audit.js（verifyChain）',
    effect: 'denied',
    permissions: ['audit.view'],
  },
  {
    code: 'ASSESSMENT_NOT_SELF',
    name: '自查独立于起草',
    nameEn: 'Assessment is independent of authorship',
    description: '重缺陷（DISS）与变更（CHG）的关闭步骤拒绝记录作者本人签署；报告核查（CHEERS）由 QA 独立执行，起草者不能给自己核查。',
    descriptionEn: 'Closure steps refuse the record author; CHEERS assessment is performed independently of the drafter.',
    basis: 'CHEERS 2022（独立报告）；职责分离',
    enforced: 'src/domain/workflow.js（independentOfAuthor）',
    effect: 'conditional',
    permissions: ['record.close', 'cheers.manage'],
  },
  {
    code: 'MODEL_PUBLISH_GATE',
    name: '模型发布必须经过独立验证',
    nameEn: 'Model publishing requires independent validation',
    description: '经济模型的发布步骤要求先完成内部验证（ISPOR-SMDM 七问）并由独立角色（HEOR 负责人）批准；发布步骤声明为独立步骤，避免"自己建模型自己放行"。',
    descriptionEn: 'Publishing an economic model requires completed internal validation and an independent approval step.',
    basis: 'ISPOR-SMDM 模型透明度与验证良好实践（七问）',
    enforced: '流程定义 seed/workflows/model.json（requiresFields + independentOfAuthor）',
    effect: 'conditional',
    permissions: ['model.publish', 'model.validate'],
  },
  {
    code: 'EXTERNAL_REVIEW_TIMEBOX',
    name: '外部评审访问限时',
    nameEn: 'External review access is time-boxed',
    description: '外部评审专家的访问有到期时间，登录时与每个请求都校验；到期自动失效并记录原因。评审结束即关门。',
    descriptionEn: 'External reviewer access expires; enforced at sign-in and on every request.',
    basis: '数据安全；限时授权原则',
    enforced: 'src/core/auth.js · resolveSession / login（ACCESS_EXPIRED）',
    effect: 'conditional',
    permissions: ['record.view'],
  },
  {
    code: 'CLOSED_RECORD_REOPEN',
    name: '关闭记录不自动放行',
    nameEn: 'No silent reopening after closure',
    description: '数据问题纠正后不会自动恢复任何东西——重新运行分析、重出报告都需要一条有理由的变更记录，由独立角色批准。',
    descriptionEn: 'Recovery after a data issue requires a reasoned change record approved independently.',
    basis: 'ALCOA+；变更管理',
    enforced: '流程定义 seed/workflows/chg.json',
    effect: 'conditional',
    permissions: ['change.manage', 'record.edit'],
  },
];

function forPermission(permission) {
  return CONSTRAINTS.filter((c) => !c.permissions || c.permissions.includes(permission));
}

function forRole(role) {
  return CONSTRAINTS;
}

function byCategory() {
  const out = {};
  for (const c of CONSTRAINTS) {
    const cat = '职责分离 / 完整性 / 报告可信度';
    (out[cat] = out[cat] || []).push(c);
  }
  return out;
}

module.exports = { CONSTRAINTS, forPermission, forRole, byCategory };