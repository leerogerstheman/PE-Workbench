'use strict';

/**
 * Who may see what about whom.
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * An earlier design put roles into levels — 1 for the overall lead, 2 for a
 * domain lead — and let a higher level see everyone below it. That was rejected.
 * Pharmacoeconomic work does not organise authority by rank: the kernel already
 * enforces that a QA person cannot close a record they authored, and that an
 * administrator cannot be the sole approver of anything. A rank model
 * reintroduces exactly the inference those rules exist to prevent.
 *
 * So visibility is derived from FUNCTIONAL RELATIONSHIP, not seniority:
 *
 *   1. CROSS-DOMAIN — HEOR QA, internal review and external reviewers see roles
 *      across all domains, because their function is defined across domains.
 *      This is a named, reasoned grant, not a rank.
 *
 *   2. OWN AREA — roles with a declared home domain see the roles and people
 *      working in that domain. This is the team you work with: the modeler
 *      knowing who the evidence specialist is, is not a disclosure, it is the
 *      job.
 *
 *   3. PUBLIC — everyone else (including the system administrator) sees only
 *      role names, duties and permission counts. Technical access is not a
 *      licence to read others' analysis work.
 *
 * Every refusal carries a reason (`visibility.decisions`), issued by the server;
 * the front end only renders decisions, it never infers them.
 */

const HOME_AREAS_BY_ROLE = {
  heor_lead: ['RSD', 'EVS', 'OUT', 'CST', 'MDL', 'ANA', 'RPT'],
  heor_researcher: ['RSD', 'EVS', 'OUT', 'CST', 'ANA', 'RPT'],
  modeler: ['MDL', 'ANA', 'CST', 'OUT'],
  evidence_specialist: ['EVS', 'RSD'],
  biostatistician: ['EVS', 'MDL', 'ANA'],
  clinical_advisor: ['RSD', 'OUT', 'MDL', 'ANA'],
  hta_officer: ['RPT', 'ANA'],
  heor_qa: ['RSD', 'EVS', 'OUT', 'CST', 'MDL', 'ANA', 'RPT'],
  data_manager: ['CST', 'OUT', 'EVS'],
  coordinator: ['RSD', 'RPT'],
};

/**
 * Visibility tier for a role:
 *   cross_domain  — sees the full register (person names and responsibilities)
 *   own_area      — sees roles that work in at least one of its home areas
 *   public        — sees only role names, duties and permission counts
 */
function tierForRole(role) {
  if (['heor_qa', 'auditor_external'].includes(role)) return 'cross_domain';
  if (HOME_AREAS_BY_ROLE[role]) return 'own_area';
  return 'public';
}

function homeAreasByRole() {
  return HOME_AREAS_BY_ROLE;
}

/**
 * Decide what the authenticated user may see of a role card.
 * @returns {{visible: boolean, tier: string, reason: string, publicFields: string[]}}
 */
function decide(actor, targetRole, context = {}) {
  const tier = tierForRole(targetRole);
  const actorTier = actor ? tierForRole(actor.role) : 'public';

  if (actor && actor.role === targetRole) {
    return {
      visible: true, tier, reason: '这是你自己的岗位。',
      publicFields: [],
    };
  }
  if (actorTier === 'cross_domain') {
    return {
      visible: true, tier,
      reason: context.crossDomainReason || 'HEOR QA / 外部评审按职能需要查看全部岗位。',
      publicFields: [],
    };
  }
  if (tier === 'public') {
    return {
      visible: true, tier,
      reason: '该岗位仅公开岗位名、职责与权限（不公开人员信息）。',
      publicFields: ['name', 'duties', 'permissions'],
    };
  }
  if (actorTier === 'own_area') {
    const home = HOME_AREAS_BY_ROLE[actor.role] || [];
    const target = HOME_AREAS_BY_ROLE[targetRole] || [];
    const overlap = home.filter((a) => target.includes(a));
    if (overlap.length) {
      return {
        visible: true, tier,
        reason: `你与对方在 ${overlap.join(' / ')} 领域共事。`,
        publicFields: [],
      };
    }
    return {
      visible: false, tier,
      reason: `你（${actor.role}）的职责范围是 ${home.length ? home.join(' / ') : '未声明'}，对方（${targetRole}）不在其中。`,
      publicFields: ['name', 'duties', 'permissions'],
    };
  }
  return {
    visible: false, tier,
    reason: '该岗位的人员信息不向你公开（职能范围之外）。',
    publicFields: ['name', 'duties', 'permissions'],
  };
}

/**
 * Compute the visibility decisions for every role on a domain page.
 */
function decisionsForDomain(actor, domainCode) {
  const rbac = require('../core/rbac');
  const out = {};
  for (const role of Object.keys(rbac.ROLES)) {
    const tier = tierForRole(role);
    // Roles that never appear in a domain register are not rendered at all.
    if (tier === 'public') continue;
    const home = HOME_AREAS_BY_ROLE[role] || [];
    if (!home.includes(domainCode)) continue;
    out[role] = decide(actor, role);
  }
  return out;
}

module.exports = { decide, tierForRole, homeAreasByRole, decisionsForDomain, HOME_AREAS_BY_ROLE };