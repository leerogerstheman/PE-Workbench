'use strict';

/**
 * REST API routing for the PharmacoEconomics Workbench.
 *
 * Every route is declared with the permission it requires, so authorisation is
 * reviewable in one place. Routes are matched in declaration order.
 *
 * Route table entries:
 *   { method, pattern, permission?, auth?, handler }
 * `permission` is checked against the RBAC matrix; `auth: false` marks the few
 * endpoints reachable without a session (login, health, bootstrap, first-admin).
 */

const config = require('../config');
const db = require('../core/db');
const audit = require('../core/audit');
const authCore = require('../core/auth');
const cryptoUtil = require('../core/crypto');
const rbac = require('../core/rbac');
const { PERMISSIONS: P } = rbac;
const { SESSION_COOKIE } = require('./cookie');

const documents = require('../domain/documents');
const workflow = require('../domain/workflow');
const inspections = require('../domain/inspections');
const dashboard = require('../domain/dashboard');
const inbox = require('../domain/inbox');
const accounts = require('../domain/accounts');
const explorer = require('../domain/explorer');
const constraints = require('../domain/constraints');
const analysis = require('../domain/analysis');
const visibility = require('../domain/visibility');

// ------------------------------------------------------------- utilities ----

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function bad(code, message, details) { return new HttpError(400, code, message, details); }
function notFound(message) { return new HttpError(404, 'NOT_FOUND', message); }
function forbidden(code, message) { return new HttpError(403, code, message); }

function requireString(body, field, { min = 1, max = 5000 } = {}) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length < min) {
    throw bad('FIELD_REQUIRED', `Field "${field}" is required (minimum ${min} characters)`);
  }
  if (value.length > max) throw bad('FIELD_TOO_LONG', `Field "${field}" exceeds ${max} characters`);
  return value.trim();
}

function optionalString(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function optionalNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** Reject a missing permission with a recorded denial. */
function requirePermission(user, permission) {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Sign in to access this resource');
  if (!rbac.hasPermission(user, permission)) {
    audit.append({
      action: 'permission_denied',
      entityType: 'api',
      entityId: permission,
      actor: user,
      reason: `Missing permission ${permission}`,
      ctx: (user && user._ctx) || {},
      severity: 'warning',
    });
    throw forbidden('PERMISSION_DENIED', `You do not hold permission "${permission}"`);
  }
  return true;
}

function attachContext(user, ctx) {
  if (user) user._ctx = ctx;
  return user;
}

function sessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${12 * 3600}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function ok(body, status = 200) { return { status, body }; }

// ---------------------------------------------------------------- routes -----

const routes = [];

function route(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, ...opts });
}

function match(pattern, urlPath) {
  const parts = pattern.split('/').filter(Boolean);
  const actual = urlPath.split('/').filter(Boolean);
  if (parts.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (parts[i] !== actual[i]) return null;
  }
  return params;
}

// -------------------------------------------------------------- bootstrap ----

route('GET', '/api/health', () => ok({
  ok: true,
  app: config.app.name,
  nameZh: config.app.nameZh,
  version: config.app.version,
}), { auth: false });

route('GET', '/api/bootstrap', () => {
  const activeAdmins = db.get(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'system_admin' AND status = 'active'"
  ).n;
  const choices = accounts.loginChoices();
  const domains = explorer.listDomains();
  return ok({
    app: { name: config.app.name, nameZh: config.app.nameZh, version: config.app.version },
    features: config.features,
    demoMode: config.features.builtinAccounts,
    requiresFirstAdmin: activeAdmins === 0 && !config.features.builtinAccounts,
    firstAdminReady: activeAdmins === 0,
    loginChoices: choices,
    passwordHint: config.features.builtinAccounts ? accounts.passwordHint() : null,
    domains: domains.map((d) => ({
      code: d.code, name: d.name, nameEn: d.nameEn, colour: d.colour,
      philosophy: d.philosophy, processCount: d.processCount,
      roleCount: d.roleCount, recordCount: d.recordCount,
    })),
    security: {
      passwordMinLength: config.security.passwordMinLength,
      passwordRequireClasses: config.security.passwordRequireClasses,
      idleTimeoutMinutes: config.security.idleTimeoutMinutes,
      sessionAbsoluteHours: config.security.sessionAbsoluteHours,
      signatureSecondFactor: config.features.signatureSecondFactor,
    },
  });
}, { auth: false });

// First administrator (only when no active admin exists and demo is off).
route('POST', '/api/setup', (body, user, ctx) => {
  const existing = db.get(
    "SELECT id FROM users WHERE role = 'system_admin' AND status = 'active' ORDER BY id LIMIT 1"
  );
  if (existing) throw forbidden('ALREADY_CONFIGURED', 'An administrator already exists');
  const username = requireString(body, 'username', { min: 3, max: 40 });
  const fullName = requireString(body, 'fullName', { min: 2, max: 60 });
  const password = requireString(body, 'password', { min: config.security.passwordMinLength, max: 200 });
  const check = authCore.validatePassword(password, { username });
  if (!check.ok) throw bad('PASSWORD_POLICY', check.errors.join('; '));
  const h = cryptoUtil.hashPassword(password);
  const now = new Date().toISOString();
  const res = db.run(
    'INSERT INTO users (username, full_name, role, status, password_hash, password_algo, password_salt, ' +
    'password_changed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [username, fullName, 'system_admin', 'active', h.hash, h.algo, h.salt, now, now, now]
  );
  const id = db.get('SELECT last_insert_rowid() AS id').id;
  audit.append({
    action: 'first_admin_created', entityType: 'users', entityId: id, recordKey: `users:${id}`,
    actor: null, reason: 'First administrator provisioned', ctx, severity: 'critical',
  });
  const session = authCore.createSession(db.get('SELECT * FROM users WHERE id = ?', [id]), ctx);
  return { status: 200, body: { ok: true }, setCookie: sessionCookie(session.id) };
}, { auth: false });

// ---------------------------------------------------------------- session ----

route('POST', '/api/login', (body, user, ctx) => {
  const username = requireString(body, 'username', { min: 2, max: 60 });
  const result = authCore.login({
    username,
    password: String(body.password || ''),
    totp: body.totp || null,
    ctx,
  });
  if (!result.ok) {
    const status = result.code === 'TOTP_REQUIRED' ? 200 : 401;
    return ok({ ok: false, code: result.code, message: loginMessage(result), ...result }, status);
  }
  return { status: 200, body: { ok: true, user: result.user, session: result.session }, setCookie: sessionCookie(result.session.id) };
}, { auth: false });

function loginMessage(result) {
  const messages = {
    INVALID_CREDENTIALS: '账号或密码不正确。',
    ACCOUNT_LOCKED: '账号已锁定，请稍后重试或联系系统管理员。',
    ACCOUNT_DISABLED: '账号已被停用。',
    ACCOUNT_PENDING: '账号尚未激活。',
    ACCESS_EXPIRED: '该账号的访问权限已到期（外部评审访问为限时授权）。',
    TOTP_REQUIRED: '请输入动态口令（TOTP）。',
    TOTP_INVALID: '动态口令不正确。',
  };
  return messages[result.code] || '登录失败。';
}

route('POST', '/api/logout', (body, user, ctx) => {
  // `logout` is public so a dead session can still be cleared; revoke the
  // server-side session from the request context either way.
  if (ctx && ctx.sessionId) authCore.revokeSession(ctx.sessionId, 'logout');
  else if (user && user._sessionId) authCore.revokeSession(user._sessionId, 'logout');
  return { status: 200, body: { ok: true }, setCookie: clearSessionCookie() };
}, { auth: false });

route('GET', '/api/me', (body, user, ctx, params, query) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  return ok({ user: authCore.publicUser(db.get('SELECT * FROM users WHERE id = ?', [user.id])), constraints: constraints.CONSTRAINTS.length });
});

route('POST', '/api/me/password', (body, user, ctx) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (!authCore.verifyPasswordForUser(user.id, current)) throw forbidden('CURRENT_PASSWORD_WRONG', 'Current password is incorrect');
  authCore.setPassword(user.id, next, user, ctx, { reason: 'self-service password change' });
  return ok({ ok: true });
});

route('POST', '/api/me/totp-enroll', (body, user) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  const secret = cryptoUtil.generateTotpSecret();
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [secret, user.id]);
  return ok({ secret, uri: cryptoUtil.totpUri(secret, user.username, config.security.totpIssuer) });
});

route('POST', '/api/me/totp-confirm', (body, user, ctx) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  const row = db.get('SELECT totp_secret FROM users WHERE id = ?', [user.id]);
  if (!row || !row.totp_secret) throw bad('TOTP_NOT_ENROLLED', 'Enrol first via /api/me/totp-enroll');
  const code = String(body.code || '').trim();
  if (!cryptoUtil.totpVerify(row.totp_secret, code)) throw bad('TOTP_INVALID', 'The verification code is incorrect');
  db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', [user.id]);
  audit.append({
    action: 'totp_enrolled', entityType: 'users', entityId: user.id, recordKey: `users:${user.id}`,
    actor: user, reason: 'Two-factor authentication enrolled', ctx, severity: 'critical',
  });
  return ok({ ok: true });
});

// ---------------------------------------------------------------- users -----

route('GET', '/api/users', (body, user, ctx, params, query) => {
  requirePermission(user, P.USER_VIEW);
  const rows = db.all('SELECT * FROM users ORDER BY role, username');
  return ok({ users: rows.map((r) => ({
    id: r.id, username: r.username, fullName: r.full_name, fullNameEn: r.full_name_en,
    email: r.email, department: r.department, jobTitle: r.job_title, role: r.role,
    roleLabel: (rbac.ROLES[r.role] || {}).labelZh || r.role,
    status: r.status, gxpAreas: parseJson(r.gxp_areas, []),
    accessExpiresAt: r.access_expires_at, mustChangePassword: Boolean(r.must_change_password),
    totpEnabled: Boolean(r.totp_enabled), lastLoginAt: r.last_login_at,
    createdAt: r.created_at, createdBy: r.created_by,
  })) });
});

route('POST', '/api/users', (body, user, ctx) => {
  requirePermission(user, P.USER_MANAGE);
  const username = requireString(body, 'username', { min: 3, max: 40 });
  if (db.get('SELECT id FROM users WHERE username = ?', [username])) {
    throw bad('USERNAME_TAKEN', `Username "${username}" is already taken`);
  }
  const role = requireString(body, 'role');
  if (!rbac.ROLES[role]) throw bad('UNKNOWN_ROLE', `Unknown role "${role}"`);
  const fullName = requireString(body, 'fullName', { min: 2, max: 60 });
  const h = cryptoUtil.hashPassword(String(body.initialPassword || ''));
  const now = new Date().toISOString();
  const initialPassword = body.initialPassword ? requireString(body, 'initialPassword', { min: config.security.passwordMinLength, max: 200 }) : null;
  const res = db.run(
    'INSERT INTO users (username, full_name, full_name_en, email, department, job_title, role, status, ' +
    'password_hash, password_algo, password_salt, password_changed_at, must_change_password, gxp_areas, ' +
    'access_expires_at, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [username, fullName, optionalString(body.fullNameEn), optionalString(body.email),
      optionalString(body.department), optionalString(body.jobTitle), role, body.status === 'disabled' ? 'disabled' : 'active',
      h.hash, h.algo, h.salt, initialPassword ? now : null, initialPassword ? 1 : 0,
      JSON.stringify(parseList(body.gxpAreas)), body.accessExpiresAt || null, now, now, user.id]
  );
  const id = db.get('SELECT last_insert_rowid() AS id').id;
  audit.append({
    action: 'user_created', entityType: 'users', entityId: id, recordKey: `users:${id}`,
    actor: user, reason: `Created account ${username} (${role})`, ctx, severity: 'critical',
    newValue: { username, role, gxp_areas: parseList(body.gxpAreas) },
  });
  return ok({ ok: true, id });
});

route('PATCH', '/api/users/:id', (body, user, ctx, params) => {
  requirePermission(user, P.USER_MANAGE);
  const row = db.get('SELECT * FROM users WHERE id = ?', [Number(params.id)]);
  if (!row) throw notFound('User not found');
  const patch = {};
  const before = {};
  const allowed = ['status', 'role', 'department', 'jobTitle', 'fullName', 'fullNameEn', 'email', 'accessExpiresAt'];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    const col = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    if (key === 'role' && !rbac.ROLES[body[key]]) throw bad('UNKNOWN_ROLE', `Unknown role "${body[key]}"`);
    patch[col] = body[key];
    before[col] = row[col];
  }
  if (body.gxpAreas !== undefined) {
    patch.gxp_areas = JSON.stringify(parseList(body.gxpAreas));
    before.gxp_areas = row.gxp_areas;
  }
  if (!Object.keys(patch).length) throw bad('NOTHING_TO_UPDATE', 'Nothing to update');
  patch.updated_at = new Date().toISOString();
  db.run(`UPDATE users SET ${Object.keys(patch).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...Object.values(patch), row.id]);
  audit.append({
    action: 'user_updated', entityType: 'users', entityId: row.id, recordKey: `users:${row.id}`,
    actor: user, reason: body.reason || 'Account attributes updated', ctx,
    oldValue: before, newValue: patch,
  });
  return ok({ ok: true });
});

route('POST', '/api/users/:id/reset-password', (body, user, ctx, params) => {
  requirePermission(user, P.USER_MANAGE);
  const row = db.get('SELECT * FROM users WHERE id = ?', [Number(params.id)]);
  if (!row) throw notFound('User not found');
  const pwd = String(body.newPassword || '');
  if (pwd.length < config.security.passwordMinLength) {
    throw bad('PASSWORD_TOO_SHORT', `Minimum ${config.security.passwordMinLength} characters`);
  }
  authCore.setPassword(row.id, pwd, user, ctx, { mustChange: Boolean(body.mustChange), reason: 'administrator reset' });
  return ok({ ok: true });
});

route('GET', '/api/roles', (body, user, ctx, params, query) => {
  requirePermission(user, P.USER_VIEW);
  return ok({ roles: rbac.listRoles() });
});

// ------------------------------------------------------------ domains --------

route('GET', '/api/domains', () => ok({ domains: explorer.listDomains() }), { auth: false });

route('GET', '/api/domains/:code', (body, user, ctx, params, query) => {
  const domain = explorer.getDomain(params.code, user);
  if (!domain) throw notFound('Domain not found');
  return ok({ domain });
}, { auth: false });

route('GET', '/api/workflows', (body, user, ctx, params, query) => {
  const list = workflow.listProcessTypes({ gxpArea: query.gxpArea });
  return ok({
    workflows: list.map((p) => ({
      code: p.code, name: p.name, nameEn: p.nameEn, category: p.category,
      gxpAreas: p.gxpAreas, description: p.description, slaDays: p.slaDays,
      stepCount: p.stepCount, requiresQaApproval: p.requiresQaApproval,
    })),
  });
}, { auth: false });

route('GET', '/api/workflows/:code', (body, user, ctx, params, query) => {
  const wf = explorer.getWorkflow(params.code);
  if (!wf) throw notFound('Workflow not found');
  return ok({ workflow: wf });
}, { auth: false });

// --------------------------------------------------------------- records -----

route('GET', '/api/records', (body, user, ctx, params, query) => {
  requirePermission(user, P.RECORD_VIEW);
  const result = workflow.listInstances({
    processCode: query.processCode,
    status: query.status,
    statuses: query.statuses ? parseList(query.statuses) : undefined,
    ownerId: query.ownerId,
    gxpArea: query.gxpArea,
    criticality: query.criticality,
    overdue: query.overdue === '1',
    search: query.search,
    open: query.open === '1',
    limit: optionalNumber(query.limit, 100),
    offset: optionalNumber(query.offset, 0),
  });
  const processNames = Object.fromEntries(
    workflow.listProcessTypes().map((p) => [p.code, { name: p.name, nameEn: p.nameEn }])
  );
  return ok({ ...result, processNames });
});

route('GET', '/api/records/:id', (body, user, ctx, params, query) => {
  requirePermission(user, P.RECORD_VIEW);
  const record = workflow.getInstance(params.id);
  if (!record) throw notFound('Record not found');
  return ok({ record });
});

route('POST', '/api/records', (body, user, ctx) => {
  requirePermission(user, P.RECORD_CREATE);
  const input = {
    processCode: requireString(body, 'processCode'),
    title: requireString(body, 'title', { min: 3, max: 300 }),
    summary: optionalString(body.summary),
    criticality: optionalString(body.criticality),
    dueDate: optionalString(body.dueDate) || undefined,
    product: optionalString(body.product),
    gxpAreas: parseList(body.gxpAreas),
    ownerId: optionalNumber(body.ownerId) || undefined,
    occurredAt: optionalString(body.occurredAt) || undefined,
    detectedAt: optionalString(body.detectedAt) || undefined,
    data: body.data || {},
    ...(body.data || {}),
  };
  const record = workflow.createInstance(input, user, ctx);
  return ok({ record }, 201);
});

route('PATCH', '/api/records/:id', (body, user, ctx, params) => {
  requirePermission(user, P.RECORD_EDIT);
  const reason = requireString(body, 'reason', { min: 3, max: 2000 });
  const patch = { ...body };
  delete patch.reason;
  const record = workflow.updateInstance(params.id, patch, user, ctx, reason);
  return ok({ record });
});

route('POST', '/api/records/:id/steps/:code/complete', (body, user, ctx, params) => {
  requirePermission(user, P.RECORD_EDIT);
  const record = workflow.completeStep({
    instanceId: params.id,
    stepCode: params.code,
    actor: user,
    ctx,
    outcome: body.outcome || 'completed',
    comment: body.comment || null,
    formData: body.formData || {},
    signatureId: optionalNumber(body.signatureId) || undefined,
  });
  return ok({ record });
});

route('POST', '/api/records/:id/cancel', (body, user, ctx, params) => {
  requirePermission(user, P.RECORD_CLOSE);
  const record = workflow.cancelInstance(params.id, requireString(body, 'reason', { min: 10, max: 2000 }), user, ctx);
  return ok({ record });
});

route('POST', '/api/records/:id/link', (body, user, ctx, params) => {
  requirePermission(user, P.RECORD_EDIT);
  if (body.childId) {
    return ok({ record: workflow.linkRecords(Number(params.id), Number(body.childId), optionalString(body.linkType) || 'related', user, ctx) });
  }
  if (body.parentId) {
    return ok({ record: workflow.linkRecords(Number(body.parentId), Number(params.id), optionalString(body.linkType) || 'related', user, ctx) });
  }
  throw bad('LINK_TARGET_REQUIRED', 'Provide childId or parentId');
});

// ------------------------------------------------------------- signatures ----

route('POST', '/api/signatures/challenge', (body, user, ctx) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  const session = db.get('SELECT * FROM sessions WHERE id = ?', [user._sessionId]);
  const issued = authCore.issueSigningNonce(user, session, 'signature');
  return ok(issued);
});

route('POST', '/api/signatures', (body, user, ctx) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  const required = ['meaning', 'reason', 'entityType', 'entityId', 'username', 'password'];
  const session = db.get('SELECT * FROM sessions WHERE id = ?', [user._sessionId]);
  const result = authCore.sign({
    user,
    session,
    username: requireString(body, 'username', { min: 2, max: 60 }),
    password: String(body.password || ''),
    totp: optionalString(body.totp),
    nonce: optionalString(body.nonce),
    meaning: requireString(body, 'meaning'),
    reason: requireString(body, 'reason', { min: 3, max: 2000 }),
    entityType: requireString(body, 'entityType'),
    entityId: String(body.entityId),
    recordKey: optionalString(body.recordKey),
    recordVersion: optionalNumber(body.recordVersion),
    stepCode: optionalString(body.stepCode),
    ctx,
  });
  if (!result.ok) {
    const status = result.code === 'SECOND_FACTOR_REQUIRED' ? 428 : (result.code === 'UNKNOWN_SIGNATURE_MEANING' ? 400 : 401);
    return ok({ ok: false, code: result.code, message: signatureMessage(result) }, status);
  }
  return ok(result);
});

function signatureMessage(result) {
  const messages = {
    UNKNOWN_SIGNATURE_MEANING: '未知的签名含义。',
    REASON_REQUIRED: '签名必须有理由（至少 3 个字）。',
    SIGNATURE_IDENTITY_MISMATCH: '键入的识别码与本账号不一致。',
    SIGNATURE_AUTH_FAILED: '密码不正确，签名被拒绝。',
    PASSWORD_EXPIRED_CHANGE_FIRST: '密码已过期，请先修改密码。',
    TOTP_NOT_ENROLLED: '账号未绑定动态口令。',
    TOTP_INVALID: '动态口令不正确。',
    SECOND_FACTOR_REQUIRED: '签名需要第二个识别要素：动态口令或一次性挑战码。',
    NONCE_EXPIRED: '挑战码已过期，请重新获取。',
    NONCE_ALREADY_USED: '挑战码已被使用，请重新获取。',
  };
  return messages[result.code] || '签名被拒绝。';
}

route('GET', '/api/records/:id/signatures', (body, user, ctx, params, query) => {
  requirePermission(user, P.RECORD_VIEW);
  const record = workflow.getInstance(params.id);
  if (!record) throw notFound('Record not found');
  return ok({ signatures: record.signatures });
});

// ----------------------------------------------------------------- inbox ----

route('GET', '/api/inbox', (body, user, ctx, params, query) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  return ok(inbox.inbox(user, { kind: query.kind }));
});

// -------------------------------------------------------------- dashboard ----

route('GET', '/api/dashboard', (body, user, ctx, params, query) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  return ok({ dashboard: dashboard.dashboard(user) });
});

route('GET', '/api/compliance', (body, user, ctx, params, query) => {
  requirePermission(user, P.COMPLIANCE_VIEW);
  return ok({ posture: dashboard.compliancePosture(), coverage: dashboard.coverage() });
});

route('GET', '/api/philosophy', () => ok({ philosophy: explorer.PHILOSOPHY }), { auth: false });

// ------------------------------------------------------------ assessments ----

route('GET', '/api/templates', (body, user, ctx, params, query) => {
  requirePermission(user, P.INSPECTION_VIEW);
  return ok({ templates: inspections.listTemplates({ gxpArea: query.gxpArea, scope: query.scope }) });
});

route('GET', '/api/templates/:id', (body, user, ctx, params, query) => {
  requirePermission(user, P.INSPECTION_VIEW);
  const template = inspections.getTemplate(params.id);
  if (!template) throw notFound('Template not found');
  return ok({ template });
});

route('POST', '/api/assessments', (body, user, ctx) => {
  requirePermission(user, P.INSPECTION_MANAGE);
  const assessment = inspections.startAssessment({
    title: optionalString(body.title),
    templateId: optionalNumber(body.templateId),
    gxpAreas: parseList(body.gxpAreas),
    scope: optionalString(body.scope),
    linkedRecordKey: optionalString(body.linkedRecordKey),
    dueDate: optionalString(body.dueDate),
  }, user, ctx);
  return ok({ assessment }, 201);
});

route('GET', '/api/assessments', (body, user, ctx, params, query) => {
  requirePermission(user, P.INSPECTION_VIEW);
  return ok({ assessments: inspections.listAssessments({ gxpArea: query.gxpArea, status: query.status }) });
});

route('GET', '/api/assessments/:code', (body, user, ctx, params, query) => {
  requirePermission(user, P.INSPECTION_VIEW);
  const assessment = inspections.getAssessment(params.code);
  if (!assessment) throw notFound('Assessment not found');
  return ok({ assessment });
});

route('POST', '/api/assessments/:code/findings/:findingId/assess', (body, user, ctx, params) => {
  requirePermission(user, P.INSPECTION_MANAGE);
  const assessment = inspections.assessItem(Number(params.findingId), {
    grade: requireString(body, 'grade'),
    evidence: body.evidence || '',
    observation: body.observation || '',
  }, user, ctx);
  return ok({ assessment });
});

route('POST', '/api/assessments/:code/findings/:findingId/link', (body, user, ctx, params) => {
  requirePermission(user, P.INSPECTION_MANAGE);
  const assessment = inspections.linkFindingToRecord(Number(params.findingId), Number(body.workflowId), user, ctx);
  return ok({ assessment });
});

route('POST', '/api/assessments/:code/findings/:findingId/close', (body, user, ctx, params) => {
  requirePermission(user, P.INSPECTION_MANAGE);
  const assessment = inspections.closeFinding(Number(params.findingId), { response: body.response || '' }, user, ctx);
  return ok({ assessment });
});

// ------------------------------------------------------------- analysis ------

route('POST', '/api/analysis/cea', (body, user, ctx) => {
  requirePermission(user, P.ANALYSIS_MANAGE);
  const result = analysis.calculateCEA({ ...body, _ctx: ctx }, attachContext(user, ctx));
  return ok({ calculation: result }, 201);
});

route('POST', '/api/analysis/bia', (body, user, ctx) => {
  requirePermission(user, P.ANALYSIS_MANAGE);
  const result = analysis.calculateBIA({ ...body, _ctx: ctx }, attachContext(user, ctx));
  return ok({ calculation: result }, 201);
});

route('POST', '/api/analysis/qaly', (body, user, ctx) => {
  requirePermission(user, P.ANALYSIS_MANAGE);
  const result = analysis.calculateQALY({ ...body, _ctx: ctx }, attachContext(user, ctx));
  return ok({ calculation: result }, 201);
});

route('GET', '/api/analysis', (body, user, ctx, params, query) => {
  requirePermission(user, P.ANALYSIS_MANAGE);
  return ok({ calculations: analysis.listCalculations(optionalNumber(query.limit, 50)) });
});

route('GET', '/api/analysis/:id', (body, user, ctx, params, query) => {
  requirePermission(user, P.ANALYSIS_MANAGE);
  const calculation = analysis.getCalculation(params.id);
  if (!calculation) throw notFound('Calculation not found');
  return ok({ calculation });
});

// ------------------------------------------------------------- documents -----

route('GET', '/api/documents', (body, user, ctx, params, query) => {
  requirePermission(user, P.DOC_VIEW);
  return ok({ documents: documents.listDocuments({
    docType: query.docType, status: query.status, gxpArea: query.gxpArea, ownerId: query.ownerId,
  }) });
});

route('POST', '/api/documents', (body, user, ctx) => {
  requirePermission(user, P.DOC_CREATE);
  const doc = documents.createDocument({
    title: requireString(body, 'title', { min: 3, max: 300 }),
    titleEn: optionalString(body.titleEn),
    docType: optionalString(body.docType) || 'protocol',
    gxpAreas: parseList(body.gxpAreas),
    department: optionalString(body.department),
    ownerId: optionalNumber(body.ownerId),
    reviewPeriodMonths: optionalNumber(body.reviewPeriodMonths, 24),
    summary: optionalString(body.summary),
    content: optionalString(body.content),
  }, user, ctx);
  return ok({ document: doc }, 201);
});

route('GET', '/api/documents/:id', (body, user, ctx, params, query) => {
  requirePermission(user, P.DOC_VIEW);
  const doc = documents.getDocument(params.id);
  if (!doc) throw notFound('Document not found');
  return ok({ document: doc });
});

route('POST', '/api/documents/:id/versions', (body, user, ctx, params) => {
  requirePermission(user, P.DOC_EDIT);
  const doc = documents.createVersion({
    documentId: params.id,
    version: optionalString(body.version),
    changeSummary: optionalString(body.changeSummary),
    changeReason: optionalString(body.changeReason),
    content: optionalString(body.content),
  }, user, ctx);
  return ok({ document: doc }, 201);
});

route('POST', '/api/documents/:id/versions/:versionId/approve', (body, user, ctx, params) => {
  requirePermission(user, P.DOC_APPROVE);
  const doc = documents.approveVersion(Number(params.versionId), {
    signatureId: optionalNumber(body.signatureId),
  }, user, ctx);
  return ok({ document: doc });
});

route('POST', '/api/documents/:id/read', (body, user, ctx, params) => {
  requirePermission(user, P.DOC_VIEW);
  const doc = documents.acknowledgeRead(params.id, optionalNumber(body.versionId), user, ctx);
  return ok({ document: doc });
});

route('POST', '/api/documents/:id/obsolete', (body, user, ctx, params) => {
  requirePermission(user, P.DOC_OBSOLETE);
  const doc = documents.markObsolete(params.id, requireString(body, 'reason', { min: 10, max: 2000 }), user, ctx);
  return ok({ document: doc });
});

// ----------------------------------------------------------------- audit ----

route('GET', '/api/audit', (body, user, ctx, params, query) => {
  requirePermission(user, P.AUDIT_VIEW);
  return ok(audit.query({
    entityType: query.entityType, entityId: query.entityId, recordKey: query.recordKey,
    actorId: query.actorId, action: query.action, from: query.from, to: query.to,
    severity: query.severity, search: query.search,
    limit: optionalNumber(query.limit, 100), offset: optionalNumber(query.offset, 0),
  }));
});

route('GET', '/api/audit/export', (body, user, ctx, params, query) => {
  requirePermission(user, P.AUDIT_EXPORT);
  // Record the export BEFORE generating the payload: a copy that left the
  // system is recorded even if the transfer dies halfway.
  const result = audit.query({
    from: query.from, to: query.to, action: query.action, entityType: query.entityType,
    search: query.search, limit: 5000, offset: 0,
  });
  audit.append({
    action: 'audit_exported',
    entityType: 'audit_trail',
    entityId: `rows:${result.total}`,
    actor: user,
    reason: `Exported ${result.total} audit rows (${query.from || 'all'} - ${query.to || 'now'})`,
    ctx,
    meta: { filters: query, count: result.total },
    severity: 'warning',
  });
  const lines = ['seq,at,actor,action,entity_type,entity_id,record_key,reason,severity,chain_hash'];
  for (const r of result.rows) {
    lines.push([
      r.seq, r.at, r.actor_username, r.action, r.entity_type, r.entity_id,
      r.record_key || '', String(r.reason || '').replace(/"/g, '').replace(/\n/g, ' '),
      r.severity, r.chain_hash,
    ].join(','));
  }
  return { status: 200, body: lines.join('\n'), headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="audit-export-${Date.now()}.csv"`,
  } };
});

route('POST', '/api/audit/verify', (body, user) => {
  requirePermission(user, P.AUDIT_VERIFY);
  return ok({ result: audit.verifyChain() });
});

route('GET', '/api/audit/records/:recordKey/reconstruct', (body, user, ctx, params, query) => {
  requirePermission(user, P.AUDIT_VIEW);
  return ok({ history: audit.verifyRecordHistory(params.recordKey), reconstructed: audit.reconstruct(params.recordKey, optionalNumber(query.version)) });
});

// -------------------------------------------------------------- search -----

/**
 * Global quick search for the top-bar search box (Ctrl+K).
 * Scopes respect the caller's permissions: records, documents, workflow
 * definitions, assessments and users each require their view permission.
 */
route('GET', '/api/search', (body, user, ctx, params, query) => {
  if (!user) throw forbidden('AUTH_REQUIRED', 'Not signed in');
  const q = String(query.q || '').trim();
  if (q.length < 2) return ok({ results: [] });
  const like = `%${q}%`;
  const results = [];
  const limit = Number(query.limit) || 8;

  if (rbac.hasPermission(user, P.RECORD_VIEW)) {
    const rows = db.all(
      `SELECT id, record_key, title, process_code, status, criticality, due_date,
              gxp_areas, closed_at FROM workflow_instances
       WHERE record_key LIKE ? OR title LIKE ? OR summary LIKE ? OR product LIKE ?
       ORDER BY (status IN ('closed','cancelled','rejected')), due_date IS NULL, due_date
       LIMIT ?`,
      [like, like, like, like, limit]
    );
    for (const r of rows) {
      results.push({
        kind: 'record',
        title: r.title,
        subtitle: r.record_key + ' · ' + r.process_code + ' · ' + (I18N_STATE[r.status] || r.status),
        badge: r.process_code,
        status: r.status,
        criticality: r.criticality,
        href: '#/records/' + r.id,
      });
    }
  }

  if (rbac.hasPermission(user, P.DOC_VIEW)) {
    const rows = db.all(
      `SELECT id, doc_number, title, doc_type, status FROM documents
       WHERE doc_number LIKE ? OR title LIKE ? OR summary LIKE ?
       ORDER BY updated_at DESC LIMIT ${limit}`,
      [like, like, like]
    );
    for (const r of rows) {
      results.push({
        kind: 'document',
        title: r.title,
        subtitle: r.doc_number + ' · ' + r.doc_type + ' · ' + (I18N_STATE[r.status] || r.status),
        badge: 'DOC',
        href: '#/documents/' + r.id,
      });
    }
  }

  if (rbac.hasPermission(user, P.INSPECTION_VIEW)) {
    const rows = db.all(
      `SELECT id, code, title, status FROM inspections
       WHERE code LIKE ? OR title LIKE ? ORDER BY updated_at DESC LIMIT ${Math.min(limit, 4)}`,
      [like, like]
    );
    for (const r of rows) {
      results.push({
        kind: 'assessment',
        title: r.title,
        subtitle: r.code + ' · ' + (I18N_STATE[r.status] || r.status),
        badge: 'CHK',
        href: '#/assessments/' + r.code,
      });
    }
  }

  // Workflow definitions are public reference models.
  const wfRows = db.all(
    `SELECT code, name, category FROM process_types WHERE active = 1
     AND (code LIKE ? OR name LIKE ?) ORDER BY code LIMIT ${Math.min(limit, 4)}`,
    [like, like]
  );
  for (const r of wfRows) {
    results.push({
      kind: 'workflow',
      title: r.name,
      subtitle: r.code + ' · 工作流定义',
      badge: 'FLOW',
      href: '#/workflow/' + r.code,
    });
  }

  if (rbac.hasPermission(user, P.USER_VIEW)) {
    const rows = db.all(
      `SELECT id, username, full_name, role FROM users
       WHERE username LIKE ? OR full_name LIKE ? ORDER BY id LIMIT ${Math.min(limit, 4)}`,
      [like, like]
    );
    for (const r of rows) {
      results.push({
        kind: 'user',
        title: r.full_name || r.username,
        subtitle: r.username + ' · ' + ((rbac.ROLES[r.role] || {}).labelZh || r.role),
        badge: 'USER',
        href: '#/users',
      });
    }
  }

  return ok({ results: results.slice(0, limit) });
});

const I18N_STATE = {
  draft: '草稿', in_review: '评审中', approved: '已批准', published: '已发布',
  closed: '已关闭', cancelled: '已取消', effective: '生效', in_progress: '进行中',
  analysed: '已分析',
};

// ---------------------------------------------------------------- settings ---

route('GET', '/api/settings', (body, user, ctx, params, query) => {
  requirePermission(user, P.POLICY_MANAGE);
  const policy = authCore.loadPolicy();
  return ok({ policy });
});

route('PATCH', '/api/settings', (body, user, ctx) => {
  requirePermission(user, P.POLICY_MANAGE);
  const allowed = ['passwordMinLength', 'passwordHistoryDepth', 'passwordMaxAgeDays', 'passwordRequireClasses',
    'maxFailedLogins', 'lockoutMinutes', 'idleTimeoutMinutes', 'sessionAbsoluteHours', 'signatureSecondFactor'];
  const patch = {};
  for (const key of allowed) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (!Object.keys(patch).length) throw bad('NOTHING_TO_UPDATE', 'Nothing to update');
  const policy = authCore.savePolicy(patch, user, ctx);
  return ok({ policy });
});

// ------------------------------------------------------------------ misc ----

route('GET', '/api/visibility', (body, user, ctx, params, query) => ok({
  homeAreasByRole: visibility.homeAreasByRole(),
}));

/**
 * Graceful shutdown, called by the native desktop window on exit.
 * Local-only + bearer token written to data/.shutdown-token at server start.
 */
route('POST', '/api/shutdown', (body, user, ctx) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const tokenFile = path.join(config.dataDir, '.shutdown-token');
  if (!ctx || ctx.ip !== '127.0.0.1' || !fs.existsSync(tokenFile)) {
    throw forbidden('SHUTDOWN_DENIED', 'Shutdown is only available to the local desktop window');
  }
  const expected = fs.readFileSync(tokenFile, 'utf8').trim();
  const given = String(body.token || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw forbidden('SHUTDOWN_DENIED', 'Shutdown token mismatch');
  }
  try { fs.unlinkSync(tokenFile); } catch { /* already gone */ }
  const result = require('./shutdown').trigger('desktop-window');
  return ok({ ok: result.ok });
}, { auth: false });

// ---------------------------------------------------------------- dispatch ---

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * Route dispatch. `ctx` carries { ip, userAgent, sessionId, method, path }.
 */
function handle({ method, path: urlPath, query, body, user, session, ctx }) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = match(r.pattern, urlPath);
    if (!params) continue;
    if (r.auth === false) {
      return r.handler(body || {}, null, ctx, params, query);
    }
    if (!user) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in first');
    }
    if (r.permission) requirePermission(user, r.permission);
    const decorated = { ...user, _sessionId: session ? session.id : null, _ctx: ctx };
    return r.handler(body || {}, decorated, ctx, params, query);
  }
  throw new HttpError(404, 'NOT_FOUND', `No route for ${method} ${urlPath}`);
}

module.exports = { handle, SESSION_COOKIE };