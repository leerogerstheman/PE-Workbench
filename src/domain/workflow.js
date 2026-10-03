'use strict';

/**
 * Configuration-driven controlled workflow engine.
 *
 * The insight this module encodes: a deviation, a change control, a CAPA, an
 * OOS investigation, a GLP study finding and a GCP protocol deviation are all
 * the *same shape* of process - a regulated record with an ordered set of
 * gated steps, some of which require a signed attestation by a specific role.
 *
 * Therefore the process definition is data (`seed/workflows/*.json`), and this
 * engine is the only state machine in the system. Adding a new workflow area means
 * adding a JSON file, not writing code.
 *
 * Regulatory anchors
 * ------------------
 *  - ICH Q10 §3.2.2  CAPA system requires investigation, root cause, action
 *    plan, effectiveness check.
 *  - EU GMP Annex 11 §12.1 separation of duties.
 *  - 21 CFR Part 211.192 / 211.198  deviation investigation and records.
 *  - 21 CFR Part 58 (GLP) §58.195 record retention, §58.35 QA unit independence.
 *  - ICH E6(R2) §4.5 / §5.20  protocol deviation handling and monitoring.
 */

const db = require('../core/db');
const audit = require('../core/audit');
const rbac = require('../core/rbac');

function nowIso() { return new Date().toISOString(); }

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// ------------------------------------------------------- process registry --

/** Load (or reload) process definitions from `seed/workflows`. */
function register(definition, sourceFile) {
  const required = ['code', 'name', 'states', 'steps'];
  for (const key of required) {
    if (!definition[key]) throw new Error(`process definition missing "${key}" (${sourceFile || definition.code})`);
  }
  const codes = new Set(definition.steps.map((s) => s.code));
  if (codes.size !== definition.steps.length) throw new Error(`duplicate step codes in ${definition.code}`);
  for (const step of definition.steps) {
    if (step.onComplete && !definition.states.includes(step.onComplete)) {
      throw new Error(`${definition.code}: step ${step.code} targets unknown state "${step.onComplete}"`);
    }
  }
  if (!definition.states.includes(definition.initialState)) {
    throw new Error(`${definition.code}: initialState "${definition.initialState}" is not in states[]`);
  }

  const before = db.get('SELECT * FROM process_types WHERE code = ?', [definition.code]);
  db.run(
    'INSERT INTO process_types (code, name, name_en, category, gxp_areas, regulation_refs, description, description_en, ' +
    'sla_days, requires_root_cause, requires_effectiveness_check, requires_qa_approval, criticality_levels, ' +
    'definitions_json, source_file, active, loaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(code) DO UPDATE SET name = excluded.name, name_en = excluded.name_en, category = excluded.category, ' +
    'gxp_areas = excluded.gxp_areas, regulation_refs = excluded.regulation_refs, description = excluded.description, ' +
    'description_en = excluded.description_en, sla_days = excluded.sla_days, ' +
    'requires_root_cause = excluded.requires_root_cause, ' +
    'requires_effectiveness_check = excluded.requires_effectiveness_check, ' +
    'requires_qa_approval = excluded.requires_qa_approval, criticality_levels = excluded.criticality_levels, ' +
    'definitions_json = excluded.definitions_json, source_file = excluded.source_file, active = 1, ' +
    'loaded_at = excluded.loaded_at',
    [
      definition.code, definition.name, definition.nameEn || null,
      definition.category || 'quality', JSON.stringify(definition.gxpAreas || []),
      JSON.stringify(definition.regulationRefs || []),
      definition.description || null, definition.descriptionEn || null,
      definition.slaDays != null ? Number(definition.slaDays) : null,
      definition.requiresRootCause ? 1 : 0,
      definition.requiresEffectivenessCheck ? 1 : 0,
      definition.requiresQaApproval === false ? 0 : 1,
      JSON.stringify(definition.criticalityLevels || ['minor', 'major', 'critical']),
      JSON.stringify(definition), sourceFile || null, 1, nowIso(),
    ]
  );
  return { code: definition.code, changed: !before || before.definitions_json !== JSON.stringify(definition) };
}

function getDefinition(processCode) {
  const row = db.get('SELECT * FROM process_types WHERE code = ? AND active = 1', [String(processCode)]);
  if (!row) return null;
  const def = parseJson(row.definitions_json, null);
  if (!def) return null;
  return { ...def, _meta: { loadedAt: row.loaded_at, sourceFile: row.source_file } };
}

function listProcessTypes(filters = {}) {
  let rows = db.all('SELECT * FROM process_types WHERE active = 1 ORDER BY category, code');
  if (filters.gxpArea) {
    rows = rows.filter((r) => parseJson(r.gxp_areas, []).includes(filters.gxpArea));
  }
  return rows.map(decorateProcessType);
}

function decorateProcessType(row) {
  const def = parseJson(row.definitions_json, {});
  return {
    code: row.code,
    name: row.name,
    nameEn: row.name_en,
    category: row.category,
    gxpAreas: parseJson(row.gxp_areas, []),
    regulationRefs: parseJson(row.regulation_refs, []),
    description: row.description,
    descriptionEn: row.description_en,
    slaDays: row.sla_days,
    requiresRootCause: Boolean(row.requires_root_cause),
    requiresEffectivenessCheck: Boolean(row.requires_effectiveness_check),
    requiresQaApproval: Boolean(row.requires_qa_approval),
    criticalityLevels: parseJson(row.criticality_levels, []),
    stepCount: (def.steps || []).length,
    steps: (def.steps || []).map((s) => ({
      code: s.code, name: s.name, nameEn: s.nameEn, role: s.role,
      signatureMeaning: s.signatureMeaning, optional: Boolean(s.optional),
    })),
    fields: def.fields || [],
    sourceFile: row.source_file,
  };
}

// ------------------------------------------------------------- instances ---

function nextRecordKey(processCode) {
  const def = getDefinition(processCode);
  const prefix = (def && def.recordPrefix) || processCode.toUpperCase().slice(0, 6);
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const row = db.get(
    "SELECT record_key FROM workflow_instances WHERE record_key LIKE ? ORDER BY LENGTH(record_key) DESC, record_key DESC LIMIT 1",
    [like]
  );
  let next = 1;
  if (row) {
    const parts = row.record_key.split('-');
    const tail = Number.parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

/**
 * Create a new process instance and materialise its step checklist.
 */
function createInstance(input, actor, ctx) {
  const def = getDefinition(input.processCode);
  if (!def) throw httpError(400, 'UNKNOWN_PROCESS_TYPE', `No active process type "${input.processCode}"`);
  if (!input.title || String(input.title).trim().length < 3) {
    throw httpError(400, 'TITLE_REQUIRED', 'A descriptive title of at least 3 characters is required');
  }

  const missing = requiredFieldsMissing(def, input);
  if (missing.length) {
    throw httpError(400, 'REQUIRED_FIELDS_MISSING', `Missing required fields: ${missing.join(', ')}`);
  }

  const createdAt = nowIso();
  const slaDays = def.slaDays || 30;
  const dueDate = input.dueDate || new Date(Date.now() + slaDays * 86400000).toISOString().slice(0, 10);
  const firstStep = (def.steps || []).find((s) => !s.optional) || (def.steps || [])[0];

  let instanceId;
  let recordKey;
  db.transaction(() => {
    recordKey = nextRecordKey(input.processCode);
    const res = db.run(
      'INSERT INTO workflow_instances (record_key, process_code, title, summary, status, current_step, site, department, ' +
      'gxp_areas, criticality, parent_id, link_type, source_entity_type, source_entity_id, reported_by, owner_id, ' +
      'qa_owner_id, occurred_at, detected_at, due_date, batch_number, product, study_code, protocol_number, subject_id, ' +
      'data_json, record_version, created_at, updated_at, created_by) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        recordKey, input.processCode, String(input.title).trim(), input.summary || null,
        def.initialState || 'draft', firstStep ? firstStep.code : null,
        input.site || null, input.department || null,
        JSON.stringify(input.gxpAreas && input.gxpAreas.length ? input.gxpAreas : (def.gxpAreas || [])),
        input.criticality || defaultCriticality(def),
        input.parentId || null, input.linkType || null,
        input.sourceEntityType || null, input.sourceEntityId != null ? String(input.sourceEntityId) : null,
        actor ? actor.id : null, input.ownerId || (actor ? actor.id : null), input.qaOwnerId || null,
        input.occurredAt || null, input.detectedAt || createdAt,
        dueDate, input.batchNumber || null, input.product || null,
        input.studyCode || null, input.protocolNumber || null, input.subjectId || null,
        JSON.stringify(input.data || {}), 1, createdAt, createdAt, actor ? actor.id : null,
      ]
    );
    instanceId = db.get('SELECT last_insert_rowid() AS id').id;
    materialiseSteps(instanceId, def);
    db.run(
      'INSERT INTO workflow_history (instance_id, at, actor_id, actor_name, from_status, to_status, step_code, action, comment) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
      [instanceId, createdAt, actor ? actor.id : null, actor ? (actor.full_name || actor.username) : 'system',
        null, def.initialState || 'draft', firstStep ? firstStep.code : null, 'created',
        input.summary || 'Record initiated']
    );
  });

  audit.append({
    action: 'create',
    entityType: 'workflow_instances',
    entityId: instanceId,
    recordKey,
    recordVersion: 1,
    actor,
    reason: input.summary || `Initiated ${def.name}`,
    ctx,
    gxpAreas: parseJson(db.get('SELECT gxp_areas FROM workflow_instances WHERE id = ?', [instanceId]).gxp_areas, []),
    newValue: {
      record_key: recordKey, process_code: input.processCode, title: input.title,
      criticality: input.criticality || defaultCriticality(def), due_date: dueDate,
      batch_number: input.batchNumber || null, product: input.product || null,
    },
    severity: 'info',
  });

  return getInstance(instanceId);
}

function defaultCriticality(def) {
  const levels = def.criticalityLevels || ['minor', 'major', 'critical'];
  return levels.includes('major') ? 'major' : levels[0];
}

function requiredFieldsMissing(def, input) {
  const missing = [];
  for (const field of def.fields || []) {
    if (!field.required) continue;
    const value = input[field.key] !== undefined ? input[field.key] : (input.data || {})[field.key];
    if (value === undefined || value === null || value === '') missing.push(field.key);
  }
  return missing;
}

/**
 * A step's `role` may be a single role or a list of roles. The column is TEXT,
 * so a list is stored as JSON - the same convention used for every other
 * list-valued column (`gxp_areas`, `applies_to_roles`, ...).
 */
function assigneeRoleText(role) {
  if (Array.isArray(role)) return role.length ? JSON.stringify(role) : null;
  return role ? String(role) : null;
}

/** Inverse of `assigneeRoleText`; always yields an array of role codes. */
function assigneeRoleList(stored) {
  if (!stored) return [];
  if (Array.isArray(stored)) return stored;
  const parsed = parseJson(stored, null);
  return Array.isArray(parsed) ? parsed : [String(stored)];
}

function materialiseSteps(instanceId, def) {
  const createdAt = nowIso();
  let seq = 0;
  for (const step of def.steps || []) {
    seq += 1;
    db.run(
      'INSERT INTO workflow_steps (instance_id, seq, step_code, name, name_en, step_type, status, assignee_role, ' +
      'signature_meaning, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [instanceId, seq, step.code, step.name, step.nameEn || null, step.type || 'task',
        'pending', assigneeRoleText(step.role), step.signatureMeaning || null, createdAt]
    );
  }
}

function getInstance(idOrKey) {
  const row = /^\d+$/.test(String(idOrKey))
    ? db.get('SELECT * FROM workflow_instances WHERE id = ?', [Number(idOrKey)])
    : db.get('SELECT * FROM workflow_instances WHERE record_key = ?', [String(idOrKey)]);
  if (!row) return null;
  const def = getDefinition(row.process_code);
  const steps = db.all('SELECT * FROM workflow_steps WHERE instance_id = ? ORDER BY seq', [row.id]);
  const history = db.all('SELECT * FROM workflow_history WHERE instance_id = ? ORDER BY at ASC, id ASC', [row.id]);
  const signatures = db.all('SELECT * FROM signatures WHERE record_key = ? ORDER BY signed_at ASC', [row.record_key]);
  const children = db.all(
    'SELECT id, record_key, process_code, title, status, due_date, criticality, link_type FROM workflow_instances WHERE parent_id = ?',
    [row.id]
  );
  const parent = row.parent_id
    ? db.get('SELECT id, record_key, process_code, title, status FROM workflow_instances WHERE id = ?', [row.parent_id])
    : null;

  return {
    id: row.id,
    recordKey: row.record_key,
    processCode: row.process_code,
    processName: def ? def.name : row.process_code,
    processNameEn: def ? def.nameEn : null,
    title: row.title,
    summary: row.summary,
    status: row.status,
    currentStep: row.current_step,
    site: row.site,
    department: row.department,
    gxpAreas: parseJson(row.gxp_areas, []),
    criticality: row.criticality,
    reportedBy: row.reported_by,
    ownerId: row.owner_id,
    qaOwnerId: row.qa_owner_id,
    occurredAt: row.occurred_at,
    detectedAt: row.detected_at,
    dueDate: row.due_date,
    closedAt: row.closed_at,
    batchNumber: row.batch_number,
    product: row.product,
    studyCode: row.study_code,
    protocolNumber: row.protocol_number,
    subjectId: row.subject_id,
    data: parseJson(row.data_json, {}),
    rootCause: row.root_cause,
    rootCauseMethod: row.root_cause_method,
    impactAssessment: row.impact_assessment,
    immediateAction: row.immediate_action,
    effectivenessCheck: row.effectiveness_check,
    effectivenessResult: row.effectiveness_result,
    recordVersion: row.record_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    overdue: isOverdue(row),
    daysToDue: daysToDue(row.due_date),
    parent,
    children,
    steps: steps.map((s) => ({
      id: s.id,
      code: s.step_code,
      seq: s.seq,
      name: s.name,
      nameEn: s.name_en,
      type: s.step_type,
      status: s.status,
      assigneeRole: s.assignee_role ? assigneeRoleList(s.assignee_role) : null,
      assigneeId: s.assignee_id,
      completedAt: s.completed_at,
      completedBy: s.completed_by,
      dueDate: s.due_date,
      outcome: s.outcome,
      comment: s.comment,
      formData: parseJson(s.form_data, {}),
      signatureMeaning: s.signature_meaning,
      signatureId: s.signature_id,
    })),
    history: history.map((h) => ({
      at: h.at, actor: h.actor_name, fromStatus: h.from_status, toStatus: h.to_status,
      stepCode: h.step_code, action: h.action, comment: h.comment, signatureId: h.signature_id,
    })),
    signatures: signatures.map((s) => ({
      id: s.id, printedName: s.printed_name, username: s.username, meaning: s.meaning,
      meaningCode: s.meaning_code, reason: s.reason, signedAt: s.signed_at, valid: Boolean(s.valid),
      stepCode: s.step_code, manifest: `${s.meaning} / ${s.printed_name} / ${s.signed_at}`,
    })),
    definition: def ? {
      states: def.states,
      initialState: def.initialState,
      terminalStates: def.terminalStates || [],
      fields: def.fields || [],
      requiresRootCause: Boolean(def.requiresRootCause),
      requiresEffectivenessCheck: Boolean(def.requiresEffectivenessCheck),
      regulationRefs: def.regulationRefs || [],
    } : null,
  };
}

function isOverdue(row) {
  if (row.closed_at) return false;
  if (!row.due_date) return false;
  return Date.parse(row.due_date) < Date.now();
}

function daysToDue(dueDate) {
  if (!dueDate) return null;
  return Math.ceil((Date.parse(dueDate) - Date.now()) / 86400000);
}

function listInstances(filters = {}) {
  const where = [];
  const params = [];
  if (filters.processCode) { where.push('process_code = ?'); params.push(filters.processCode); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.statuses && filters.statuses.length) {
    where.push(`status IN (${filters.statuses.map(() => '?').join(',')})`);
    params.push(...filters.statuses);
  }
  if (filters.ownerId) { where.push('owner_id = ?'); params.push(Number(filters.ownerId)); }
  if (filters.open === true) { where.push("status NOT IN ('closed','cancelled','rejected')"); }
  if (filters.criticality) { where.push('criticality = ?'); params.push(filters.criticality); }
  if (filters.overdue) { where.push("due_date < date('now') AND closed_at IS NULL"); }
  if (filters.search) {
    where.push('(title LIKE ? OR record_key LIKE ? OR batch_number LIKE ? OR product LIKE ? OR summary LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like);
  }
  if (filters.gxpArea) {
    where.push('gxp_areas LIKE ?');
    params.push(`%"${filters.gxpArea}"%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(filters.limit) || 100, 500);
  const offset = Number(filters.offset) || 0;
  const total = db.get(`SELECT COUNT(*) AS n FROM workflow_instances ${clause}`, params).n;
  const rows = db.all(
    `SELECT * FROM workflow_instances ${clause} ORDER BY
       CASE status WHEN 'draft' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'pending_qa_review' THEN 3 ELSE 4 END,
       due_date IS NULL, due_date ASC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return {
    total, limit, offset,
    rows: rows.map((r) => ({
      id: r.id, recordKey: r.record_key, processCode: r.process_code, title: r.title,
      status: r.status, currentStep: r.current_step, criticality: r.criticality,
      gxpAreas: parseJson(r.gxp_areas, []), ownerId: r.owner_id,
      dueDate: r.due_date, closedAt: r.closed_at, overdue: isOverdue(r), daysToDue: daysToDue(r.due_date),
      batchNumber: r.batch_number, product: r.product, createdAt: r.created_at,
      rootCause: r.root_cause, effectivenessResult: r.effectiveness_result,
    })),
  };
}

/**
 * Complete the current (or a named) step.
 *
 * Enforces, in order:
 *   1. the record is not in a terminal state,
 *   2. the step exists and is not already complete,
 *   3. the actor's role matches the step's required role (separation of duties),
 *   4. if the step declares a signature meaning, a valid signature was applied
 *      by *this* actor for *this* step (prevents "sign for someone else"),
 *   5. any `requiresFields` on the step have been provided.
 */
function completeStep(args) {
  const { instanceId, stepCode, actor, ctx, outcome, comment, formData, signatureId, force } = args;

  const instance = db.get('SELECT * FROM workflow_instances WHERE id = ?', [Number(instanceId)]);
  if (!instance) throw httpError(404, 'RECORD_NOT_FOUND');
  const def = getDefinition(instance.process_code);
  if (!def) throw httpError(400, 'PROCESS_TYPE_MISSING');

  const terminal = def.terminalStates || [];
  if (terminal.includes(instance.status)) {
    throw httpError(409, 'RECORD_TERMINAL', `Record ${instance.record_key} is ${instance.status} and cannot be modified further`);
  }

  const step = stepCode
    ? db.get('SELECT * FROM workflow_steps WHERE instance_id = ? AND step_code = ?', [instance.id, String(stepCode)])
    : db.get('SELECT * FROM workflow_steps WHERE instance_id = ? AND status != ? ORDER BY seq LIMIT 1', [instance.id, 'completed']);
  if (!step) throw httpError(404, 'STEP_NOT_FOUND');
  if (step.status === 'completed') throw httpError(409, 'STEP_ALREADY_COMPLETE', `Step "${step.step_code}" is already complete`);

  const stepDef = (def.steps || []).find((s) => s.code === step.step_code) || {};

  // --- 3. separation of duties --------------------------------------------
  if (step.assignee_role && !force) {
    const allowed = assigneeRoleList(step.assignee_role);
    const isHeorLead = actor.role === 'heor_lead' && def.requiresQaApproval !== false;
    if (!allowed.includes(actor.role) && !allowed.includes('*') && !isHeorLead && actor.role !== 'system_admin') {
      throw httpError(403, 'ROLE_NOT_PERMITTED',
        `Step "${step.step_code}" must be performed by: ${allowed.join(', ')}. Current role: ${actor.role}`);
    }
  }
  if (stepDef.independentOfAuthor && instance.created_by === actor.id) {
    throw httpError(403, 'INDEPENDENCE_VIOLATION',
      'This step requires an independent person (EU GMP Annex 11 §12.1 / ICH Q10 §3.2). The record author cannot close it.');
  }

  // --- 4. signature gate ---------------------------------------------------
  let verifiedSignatureId = null;
  if (step.signature_meaning) {
    if (!signatureId) {
      throw httpError(428, 'SIGNATURE_REQUIRED',
        `Step "${step.step_code}" requires an electronic signature with meaning "${step.signature_meaning}"`);
    }
    const sig = db.get('SELECT * FROM signatures WHERE id = ?', [Number(signatureId)]);
    if (!sig) throw httpError(404, 'SIGNATURE_NOT_FOUND');
    if (!sig.valid) throw httpError(409, 'SIGNATURE_INVALIDATED');
    if (sig.user_id !== actor.id) throw httpError(403, 'SIGNATURE_NOT_YOURS', 'A signature can only be applied by the person who authenticated');
    if (sig.step_code && sig.step_code !== step.step_code) {
      throw httpError(409, 'SIGNATURE_STEP_MISMATCH', `Signature was applied for step "${sig.step_code}", not "${step.step_code}"`);
    }
    if (sig.record_key && instance.record_key && sig.record_key !== instance.record_key) {
      throw httpError(409, 'SIGNATURE_RECORD_MISMATCH');
    }
    verifiedSignatureId = sig.id;
  }

  // --- 5. required data ----------------------------------------------------
  const missing = (stepDef.requiresFields || []).filter((f) => {
    const v = (formData || {})[f];
    return v === undefined || v === null || v === '';
  });
  if (missing.length) throw httpError(400, 'STEP_FIELDS_MISSING', `Step requires: ${missing.join(', ')}`);

  const completedAt = nowIso();
  const fromStatus = instance.status;
  const toStatus = stepDef.onComplete || fromStatus;
  // Which step becomes current is only known once this one is marked complete.
  let nextStep = null;

  db.transaction(() => {
    db.run(
      'UPDATE workflow_steps SET status = ?, completed_at = ?, completed_by = ?, outcome = ?, comment = ?, ' +
      'form_data = ?, signature_id = ? WHERE id = ?',
      ['completed', completedAt, actor.id, outcome || 'completed', comment || null,
        JSON.stringify(formData || {}), verifiedSignatureId, step.id]
    );
    nextStep = findNextStep(instance.id);
    // Persist step-specific narrative fields onto the instance for reporting.
    const patch = {};
    if (stepDef.persistFields) {
      for (const [col, field] of Object.entries(stepDef.persistFields)) {
        const value = (formData || {})[field];
        if (value !== undefined) patch[col] = value;
      }
    }
    if (toStatus !== fromStatus) patch.status = toStatus;
    patch.current_step = nextStep ? nextStep.step_code : null;
    if (toStatus && (def.terminalStates || []).includes(toStatus)) patch.closed_at = completedAt;
    patch.record_version = instance.record_version + 1;
    patch.updated_at = completedAt;

    applyInstancePatch(instance.id, patch);
    db.run(
      'INSERT INTO workflow_history (instance_id, at, actor_id, actor_name, from_status, to_status, step_code, action, comment, signature_id) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?)',
      [instance.id, completedAt, actor.id, actor.full_name || actor.username, fromStatus, toStatus,
        step.step_code, 'step_completed', comment || null, verifiedSignatureId]
    );
  });

  audit.recordChange({
    actor,
    entityType: 'workflow_instances',
    entityId: instance.id,
    recordKey: instance.record_key,
    recordVersion: instance.record_version + 1,
    before: { status: fromStatus, current_step: instance.current_step },
    after: { status: toStatus, current_step: nextStep ? nextStep.step_code : null, step_completed: step.step_code },
    reason: comment || `Completed step "${step.name}"`,
    ctx,
    action: 'step_complete',
    signatureId: verifiedSignatureId,
    meta: { stepCode: step.step_code, outcome: outcome || 'completed', formData: formData || {} },
    gxpAreas: parseJson(instance.gxp_areas, []),
    severity: step.signature_meaning ? 'critical' : 'info',
  });

  return getInstance(instance.id);
}

function findNextStep(instanceId) {
  return db.get(
    "SELECT * FROM workflow_steps WHERE instance_id = ? AND status != 'completed' ORDER BY seq LIMIT 1",
    [instanceId]
  );
}

function applyInstancePatch(instanceId, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  db.run(`UPDATE workflow_instances SET ${sets} WHERE id = ?`, [...cols.map((c) => patch[c]), instanceId]);
}

/** Generic field update with audit (used by the record editor). */
function updateInstance(id, patch, actor, ctx, reason) {
  const instance = db.get('SELECT * FROM workflow_instances WHERE id = ?', [Number(id)]);
  if (!instance) throw httpError(404, 'RECORD_NOT_FOUND');
  const def = getDefinition(instance.process_code);
  if (def && (def.terminalStates || []).includes(instance.status)) {
    throw httpError(409, 'RECORD_TERMINAL', 'Closed records are read-only; raise a new linked record instead (ALCOA+ / data integrity)');
  }
  if (!reason || String(reason).trim().length < 3) {
    throw httpError(400, 'REASON_REQUIRED', 'Every change to a controlled record requires a stated reason (21 CFR Part 11.10(e))');
  }

  const ALLOWED = [
    'title', 'summary', 'criticality', 'owner_id', 'qa_owner_id', 'due_date', 'site', 'department',
    'batch_number', 'product', 'study_code', 'protocol_number', 'subject_id', 'occurred_at',
    'root_cause', 'root_cause_method', 'impact_assessment', 'immediate_action',
    'effectiveness_check', 'effectiveness_result', 'gxp_areas', 'data_json', 'status',
  ];
  const dbPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    const col = toSnake(key);
    // `data` is the public name for the `data_json` column (see createInstance).
    const column = col === 'data' ? 'data_json' : col;
    if (!ALLOWED.includes(column)) continue;
    dbPatch[column] = Array.isArray(value) || (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value;
  }
  if (!Object.keys(dbPatch).length) throw httpError(400, 'NOTHING_TO_UPDATE');

  dbPatch.record_version = instance.record_version + 1;
  dbPatch.updated_at = nowIso();

  const before = {};
  const after = {};
  for (const col of Object.keys(dbPatch)) {
    if (col === 'record_version' || col === 'updated_at') continue;
    before[col] = instance[col];
    after[col] = dbPatch[col];
  }

  db.transaction(() => {
    applyInstancePatch(instance.id, dbPatch);
    db.run(
      'INSERT INTO workflow_history (instance_id, at, actor_id, actor_name, from_status, to_status, step_code, action, comment) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
      [instance.id, nowIso(), actor.id, actor.full_name || actor.username,
        instance.status, instance.status, instance.current_step, 'field_update', reason]
    );
  });

  audit.recordChange({
    actor, entityType: 'workflow_instances', entityId: instance.id,
    recordKey: instance.record_key, recordVersion: instance.record_version + 1,
    before, after, reason, ctx, action: 'update',
    gxpAreas: parseJson(instance.gxp_areas, []),
  });

  return getInstance(instance.id);
}

function toSnake(s) {
  return String(s).replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * Link two records (deviation -> CAPA, CAPA -> change control, finding -> CAPA).
 */
function linkRecords(parentId, childId, linkType, actor, ctx) {
  const parent = db.get('SELECT * FROM workflow_instances WHERE id = ?', [Number(parentId)]);
  const child = db.get('SELECT * FROM workflow_instances WHERE id = ?', [Number(childId)]);
  if (!parent || !child) throw httpError(404, 'RECORD_NOT_FOUND');
  if (parent.id === child.id) throw httpError(400, 'CANNOT_LINK_TO_SELF');
  if (child.parent_id) {
    throw httpError(409, 'ALREADY_LINKED', `${child.record_key} is already linked to another parent record`);
  }
  db.transaction(() => {
    db.run('UPDATE workflow_instances SET parent_id = ?, link_type = ?, updated_at = ? WHERE id = ?',
      [parent.id, linkType || 'related', nowIso(), child.id]);
    db.run(
      'INSERT INTO workflow_history (instance_id, at, actor_id, actor_name, from_status, to_status, step_code, action, comment) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
      [child.id, nowIso(), actor.id, actor.full_name || actor.username, child.status, child.status, null,
        'linked', `Linked to ${parent.record_key} as ${linkType || 'related'}`]
    );
  });
  audit.append({
    action: 'link', entityType: 'workflow_instances', entityId: child.id, recordKey: child.record_key,
    actor, reason: `Linked ${child.record_key} -> ${parent.record_key} (${linkType || 'related'})`,
    ctx, newValue: { parent_id: parent.id, parent_key: parent.record_key, link_type: linkType || 'related' },
  });
  return getInstance(child.id);
}

/** Cancel a record without closing it (e.g. raised in error). */
function cancelInstance(id, reason, actor, ctx) {
  const instance = db.get('SELECT * FROM workflow_instances WHERE id = ?', [Number(id)]);
  if (!instance) throw httpError(404, 'RECORD_NOT_FOUND');
  if (!reason || String(reason).trim().length < 10) {
    throw httpError(400, 'REASON_REQUIRED', 'Cancelling a controlled record requires a justification of at least 10 characters');
  }
  db.run('UPDATE workflow_instances SET status = ?, closed_at = ?, updated_at = ?, record_version = record_version + 1 WHERE id = ?',
    ['cancelled', nowIso(), nowIso(), instance.id]);
  db.run(
    'INSERT INTO workflow_history (instance_id, at, actor_id, actor_name, from_status, to_status, step_code, action, comment) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)',
    [instance.id, nowIso(), actor.id, actor.full_name || actor.username, instance.status, 'cancelled',
      instance.current_step, 'cancelled', reason]
  );
  audit.append({
    action: 'cancel', entityType: 'workflow_instances', entityId: instance.id, recordKey: instance.record_key,
    actor, reason, ctx, oldValue: { status: instance.status }, newValue: { status: 'cancelled' }, severity: 'warning',
  });
  return getInstance(instance.id);
}

/**
 * Aggregate metrics used by the dashboards: ageing, SLA breach, trend by month.
 */
function metrics(filters = {}) {
  const areaClause = filters.gxpArea ? ' WHERE gxp_areas LIKE ?' : '';
  const areaParams = filters.gxpArea ? [`%"${filters.gxpArea}"%`] : [];

  const byStatus = db.all(`SELECT status, COUNT(*) AS n FROM workflow_instances${areaClause} GROUP BY status`, areaParams);
  const byProcess = db.all(
    `SELECT process_code, COUNT(*) AS n,
            SUM(CASE WHEN status NOT IN ('closed','cancelled','rejected') THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN due_date < date('now') AND status NOT IN ('closed','cancelled','rejected') THEN 1 ELSE 0 END) AS overdue
     FROM workflow_instances${areaClause} GROUP BY process_code ORDER BY n DESC`,
    areaParams
  );
  const byCriticality = db.all(
    `SELECT criticality, COUNT(*) AS n FROM workflow_instances${areaClause} GROUP BY criticality`,
    areaParams
  );
  const trend = db.all(
    `SELECT substr(created_at, 1, 7) AS month, process_code, COUNT(*) AS n
     FROM workflow_instances${areaClause} GROUP BY month, process_code ORDER BY month DESC LIMIT 120`,
    areaParams
  );
  const ageing = db.all(
    `SELECT process_code,
       SUM(CASE WHEN julianday('now') - julianday(created_at) <= 30 THEN 1 ELSE 0 END) AS d0_30,
       SUM(CASE WHEN julianday('now') - julianday(created_at) > 30 AND julianday('now') - julianday(created_at) <= 60 THEN 1 ELSE 0 END) AS d31_60,
       SUM(CASE WHEN julianday('now') - julianday(created_at) > 60 AND julianday('now') - julianday(created_at) <= 90 THEN 1 ELSE 0 END) AS d61_90,
       SUM(CASE WHEN julianday('now') - julianday(created_at) > 90 THEN 1 ELSE 0 END) AS d90_plus
     FROM workflow_instances
     WHERE status NOT IN ('closed','cancelled','rejected')${filters.gxpArea ? ' AND gxp_areas LIKE ?' : ''}
     GROUP BY process_code`,
    areaParams
  );
  const rootCausePending = db.get(
    `SELECT COUNT(*) AS n FROM workflow_instances WHERE root_cause IS NULL AND status NOT IN ('closed','cancelled','rejected')${filters.gxpArea ? ' AND gxp_areas LIKE ?' : ''}`,
    areaParams
  ).n;
  const effCheckDue = db.get(
    `SELECT COUNT(*) AS n FROM workflow_instances WHERE effectiveness_result IS NULL AND process_code IN (SELECT code FROM process_types WHERE requires_effectiveness_check = 1) AND status NOT IN ('cancelled','rejected')${filters.gxpArea ? ' AND gxp_areas LIKE ?' : ''}`,
    areaParams
  ).n;

  return { byStatus, byProcess, byCriticality, trend, ageing, rootCausePending, effCheckDue };
}

/** Records whose current step is actionable by this user's role. */
function myActions(user, limit = 50) {
  const steps = db.all(
    `SELECT s.*, i.record_key, i.title, i.due_date, i.criticality, i.status AS instance_status, i.process_code
     FROM workflow_steps s
     JOIN workflow_instances i ON i.id = s.instance_id
     WHERE s.status != 'completed'
       AND i.status NOT IN ('closed','cancelled','rejected')
       AND (s.assignee_id = ? OR s.assignee_role IS NULL OR s.assignee_role = ? OR s.assignee_role LIKE ?)
     ORDER BY i.due_date IS NULL, i.due_date ASC, s.seq ASC
     LIMIT ?`,
    [user.id, user.role, `%"${user.role}"%`, limit]
  );
  return steps.map((s) => ({
    instanceId: s.instance_id,
    recordKey: s.record_key,
    title: s.title,
    processCode: s.process_code,
    stepCode: s.step_code,
    stepName: s.name,
    stepNameEn: s.name_en,
    signatureMeaning: s.signature_meaning,
    criticality: s.criticality,
    dueDate: s.due_date,
    overdue: s.due_date ? Date.parse(s.due_date) < Date.now() : false,
  }));
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  register,
  getDefinition,
  listProcessTypes,
  getInstance,
  listInstances,
  createInstance,
  completeStep,
  updateInstance,
  linkRecords,
  cancelInstance,
  metrics,
  myActions,
  nextRecordKey,
  httpError,
};
