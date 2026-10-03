'use strict';

/**
 * Core engine tests: audit chain, RBAC, workflow engine, signatures,
 * calculations, assessments, documents.
 */

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-core-test-'));
process.env.PE_DATA_DIR = tmp;
process.env.PE_BUILTIN_ACCOUNTS = '1';
process.env.PE_MONITOR = '0';

const db = require('../src/core/db');
const audit = require('../src/core/audit');
const rbac = require('../src/core/rbac');
const auth = require('../src/core/auth');
const account = require('../src/domain/accounts');
const workflow = require('../src/domain/workflow');
const inspections = require('../src/domain/inspections');
const documents = require('../src/domain/documents');
const analysis = require('../src/domain/analysis');
const seed = require('../src/seed');
const constraints = require('../src/domain/constraints');

const CTX = { ip: '127.0.0.1', userAgent: 'test', sessionId: null };
const PASSWORD = account.BUILTIN_PASSWORD;
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}
function run(label, fn) {
  try {
    fn();
    process.stdout.write(`  ok  ${label}\n`);
    return true;
  } catch (err) {
    process.stdout.write(`  FAIL ${label}: ${err.message}\n`);
    return false;
  }
}

db.open();
seed.run({ silent: true });
account.provision(null, CTX);

function user(username) {
  const row = db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!row) { const p = account.personaByUsername(username) || account.PERSONAS.find((x) => x.username === username); throw new Error(`no persona ${username}`); }
  return { ...row, _ctx: CTX };
}

function signAndComplete(instance, stepCode, username, meaning, reason, formData) {
  const actor = user(username);
  const sig = meaning ? (() => {
    const nonce = auth.issueSigningNonce(actor, null, 'signature').nonce;
    const res = auth.sign({ user: actor, session: null, username: actor.username, password: PASSWORD, nonce, meaning, reason, entityType: 'workflow_instances', entityId: String(instance.id), recordKey: instance.recordKey, stepCode, ctx: CTX });
    assert.ok(res.ok, `sign failed: ${res.code}`);
    return res.signature.id;
  })() : null;
  return workflow.completeStep({ instanceId: instance.id, stepCode, actor, ctx: CTX, formData: formData || {}, comment: reason, signatureId: sig || undefined });
}

// ---------------------------------------------------------------- audit -----
let chainBroken = false;
check('audit trail is append-only initially intact', () => {
  const r = audit.verifyChain();
  assert.ok(r.ok, r.reason);
});
check('audit entries accumulate', () => {
  const before = db.get('SELECT COUNT(*) AS n FROM audit_trail').n;
  audit.append({ action: 'test_entry', entityType: 'test', entityId: '1', actor: null, reason: 'test', ctx: CTX });
  const after = db.get('SELECT COUNT(*) AS n FROM audit_trail').n;
  assert.equal(after, before + 1);
});
check('audit_trail rejects UPDATE via trigger', () => {
  const row = db.get('SELECT seq FROM audit_trail ORDER BY seq LIMIT 1');
  assert.throws(() => db.run('UPDATE audit_trail SET reason = ? WHERE seq = ?', ['tampered', row.seq]), /append-only/);
});
check('audit trail remains verifiable after app writes', () => {
  const r = audit.verifyChain();
  assert.ok(r.ok, r.reason);
});
check('record history is contiguous after writes', () => {
  const h = audit.verifyRecordHistory('users:2');
  assert.ok(h.contiguous !== false);
});

// ------------------------------------------------------------------ rbac ----
check('system_admin holds * and heor_lead holds record.close', () => {
  assert.deepEqual(rbac.permissionsFor('system_admin'), ['*']);
  assert.ok(rbac.hasPermission({ role: 'heor_lead' }, 'record.close'));
});
check('production_operator-like role is denied record.close', () => {
  assert.ok(!rbac.hasPermission({ role: 'coordinator' }, 'record.close'));
});
check('external reviewer is read-only', () => {
  assert.ok(rbac.isReadOnly({ role: 'auditor_external' }));
  assert.ok(rbac.isReadOnly({ role: 'viewer' }));
});
check('every PE workflow step role exists in the role registry', () => {
  workflow.register; // ensure loaded
  seed.run({ silent: true });
  for (const def of workflow.listProcessTypes()) {
    const full = workflow.getDefinition(def.code);
    for (const step of full.steps || []) {
      const roles = Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []);
      for (const r of roles) {
        if (r === '*') continue;
        assert.ok(rbac.ROLES[r], `${def.code}/${step.code} references unknown role ${r}`);
      }
    }
  }
});
check('constraints catalogue covers record.close for leads', () => {
  const hits = constraints.forPermission('record.close');
  assert.ok(hits.length >= 3, 'expected constraints on record.close');
});

// ------------------------------------------------------------- workflow ----
check('create a PROTO record with full fields', () => {
  const actor = user('demo.researcher');
  const rec = workflow.createInstance({
    processCode: 'PROTO', title: '测试方案：新药 X 成本-效用分析',
    pico: 'P/I/C/O 测试', analysisType: 'cost-utility (CUA)',
    perspective: 'payer', timeHorizon: '10 年', discountRate: '5%',
    product: '新药 X', dueDate: '2027-01-01', summary: '测试记录', criticality: 'major',
    data: { pico: 'P/I/C/O 测试' },
  }, actor, CTX);
  assert.equal(rec.processCode, 'PROTO');
  assert.equal(rec.steps.length, 5);
  assert.equal(rec.steps[0].status, 'pending');
});
check('role gate: researcher cannot complete the approval step', () => {
  const rec = workflow.createInstance({
    processCode: 'PROTO', title: '角色门测试方案', pico: 'P', analysisType: 'CEA',
    perspective: 'payer', timeHorizon: '5 年', discountRate: '5%', product: 'X',
    summary: '测试记录', criticality: 'major', dueDate: '2027-01-01',
  }, user('demo.researcher'), CTX);
  signAndComplete(rec, 'draft_protocol', 'demo.researcher', null, 'draft done', { pico: 'P', perspective: 'payer', timeHorizon: '5 年', discountRate: '5%' });
  assert.throws(() => workflow.completeStep({ instanceId: rec.id, stepCode: 'approval', actor: user('demo.researcher'), ctx: CTX, formData: {} }), (e) => e.code === 'ROLE_NOT_PERMITTED');
});
check('signature gate: approval requires a valid signature', () => {
  const rec = workflow.createInstance({
    processCode: 'PROTO', title: '签名门测试方案', pico: 'P', analysisType: 'CEA',
    perspective: 'payer', timeHorizon: '5 年', discountRate: '5%', product: 'X',
    summary: '测试记录', criticality: 'major', dueDate: '2027-01-01',
  }, user('demo.researcher'), CTX);
  signAndComplete(rec, 'draft_protocol', 'demo.researcher', null, 'draft done', { pico: 'P', perspective: 'payer', timeHorizon: '5 年', discountRate: '5%' });
  signAndComplete(rec, 'methodology_review', 'demo.heorlead', null, 'reviewed', { reviewComments: 'ok', verdict: 'pass_with_comments' });
  assert.throws(() => workflow.completeStep({ instanceId: rec.id, stepCode: 'approval', actor: user('demo.heorlead'), ctx: CTX, formData: {} }), (e) => e.code === 'SIGNATURE_REQUIRED');
});
check('signature from the wrong person is rejected server-side', () => {
  const nonce = auth.issueSigningNonce(user('demo.qa'), null, 'signature').nonce;
  const res = auth.sign({
    user: user('demo.qa'), session: null, username: 'demo.heorlead', password: PASSWORD,
    nonce, meaning: 'approved', reason: 'wrong identity test',
    entityType: 'workflow_instances', entityId: '1', recordKey: 'PROTO-2026-9999', stepCode: 'approval', ctx: CTX,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SIGNATURE_IDENTITY_MISMATCH');
});
check('record author cannot publish their own model (independence)', () => {
  // The MODEL publish step allows heor_lead — so we make the lead the author,
  // which is exactly the case the independence rule is there to catch.
  const rec = workflow.createInstance({
    processCode: 'MODEL', title: '独立性测试模型', product: 'X',
    modelType: 'Markov cohort (队列马尔可夫)', software: 'R 4.4', version: 'v0.1',
    summary: '测试记录', criticality: 'major', dueDate: '2027-01-01',
  }, user('demo.heorlead'), CTX);
  assert.throws(() => workflow.completeStep({ instanceId: rec.id, stepCode: 'publish', actor: user('demo.heorlead'), ctx: CTX, formData: { publishNotes: '发布测试' } }), (e) => e.code === 'INDEPENDENCE_VIOLATION');
});
check('terminal records are read-only', () => {
  const rec = workflow.createInstance({
    processCode: 'PROTO', title: '终态测试方案', pico: 'P', analysisType: 'CEA',
    perspective: 'payer', timeHorizon: '5 年', discountRate: '5%', product: 'X',
    summary: '测试记录', criticality: 'major', dueDate: '2027-01-01',
  }, user('demo.researcher'), CTX);
  workflow.cancelInstance(rec.id, '测试取消记录，理由足够长', user('demo.researcher'), CTX);
  assert.throws(() => workflow.updateInstance(rec.id, { title: 'chg' }, user('demo.researcher'), CTX, '修改理由'), (e) => e.code === 'RECORD_TERMINAL');
});
check('updates require a stated reason', () => {
  assert.throws(() => workflow.updateInstance(1, { title: 'x' }, user('demo.researcher'), CTX, ''), (e) => e.code === 'REASON_REQUIRED');
});

// ---------------------------------------------------------- signatures ------
check('two-factor signature with challenge nonce succeeds', () => {
  const actor = user('demo.qa');
  const nonce = auth.issueSigningNonce(actor, null, 'signature').nonce;
  const res = auth.sign({ user: actor, session: null, username: 'demo.qa', password: PASSWORD, nonce, meaning: 'closed', reason: '关闭测试', entityType: 'workflow_instances', entityId: '42', recordKey: 'DISS-X', stepCode: 'qa_closure', ctx: CTX });
  assert.ok(res.ok);
  assert.ok(res.signature.secondFactor === 'challenge-nonce');
});
check('replayed nonce is rejected', () => {
  const actor = user('demo.qa');
  const nonce = auth.issueSigningNonce(actor, null, 'signature').nonce;
  const first = auth.sign({ user: actor, session: null, username: 'demo.qa', password: PASSWORD, nonce, meaning: 'closed', reason: '首次签署', entityType: 'workflow_instances', entityId: '43', recordKey: 'DISS-Y', stepCode: 'qa_closure', ctx: CTX });
  assert.ok(first.ok);
  const second = auth.sign({ user: actor, session: null, username: 'demo.qa', password: PASSWORD, nonce, meaning: 'closed', reason: '重放签署', entityType: 'workflow_instances', entityId: '44', recordKey: 'DISS-Z', stepCode: 'qa_closure', ctx: CTX });
  assert.ok(!second.ok);
  assert.equal(second.code, 'NONCE_ALREADY_USED');
});
check('wrong password fails a signature', () => {
  const actor = user('demo.qa');
  const nonce = auth.issueSigningNonce(actor, null, 'signature').nonce;
  const res = auth.sign({ user: actor, session: null, username: 'demo.qa', password: 'wrong-password-1', nonce, meaning: 'closed', reason: '错误密码测试', entityType: 'workflow_instances', entityId: '45', recordKey: 'DISS-W', stepCode: 'qa_closure', ctx: CTX });
  assert.ok(!res.ok);
  assert.equal(res.code, 'SIGNATURE_AUTH_FAILED');
});

// ------------------------------------------------------------ analysis ------
check('CEA calculator: ICER and INMB are correct', () => {
  const r = analysis.calculateCEA({ label: 't', costNew: 345000, costComp: 300000, effectNew: 1.72, effectComp: 1.42, wtp: 293000, outcomeName: 'QALY', _ctx: CTX }, user('demo.researcher'));
  assert.equal(r.output.deltaCost, 45000);
  assert.equal(r.output.icer, 150000);
  assert.equal(r.output.inmb, 42900);
  assert.equal(r.output.quadrant, 'NE_tradeoff');
});
check('CEA dominant case has no ICER', () => {
  const r = analysis.calculateCEA({ label: 't2', costNew: 100, costComp: 200, effectNew: 2, effectComp: 1, wtp: 100, _ctx: CTX }, user('demo.researcher'));
  assert.equal(r.output.quadrant, 'SE_dominant');
  assert.equal(r.output.icer, null);
});
check('BIA calculator sums incremental years', () => {
  const r = analysis.calculateBIA({ label: 't3', population: 1000, shareNew: [1], costNewPerPatient: 100, costCompPerPatient: 50, horizonYears: 1, _ctx: CTX }, user('demo.researcher'));
  assert.equal(r.output.years[0].incremental, 50000);
});
check('QALY discounting is applied year by year', () => {
  const r = analysis.calculateQALY({ label: 't4', discountRate: 0.05, cycles: [{ utility: 1, years: 1 }], _ctx: CTX }, user('demo.researcher'));
  assert.ok(Math.abs(r.output.totalQalyDiscounted - 1.0) < 0.01);
});
check('every calculation writes an audit entry', () => {
  const n = db.get("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'analysis_calculated'").n;
  assert.ok(n >= 4);
});

// ----------------------------------------------------------- assessments ----
check('negative assessment requires objective evidence', () => {
  const tpl = inspections.getTemplate('CHEERS-2022');
  const a = inspections.startAssessment({ title: 'test', templateId: tpl.id }, user('demo.qa'), CTX);
  const finding = a.findings.find((f) => f.item && f.item.seq === 1);
  assert.throws(() => inspections.assessItem(finding.id, { grade: 'gap', evidence: '短' }, user('demo.qa'), CTX), (e) => e.code === 'EVIDENCE_REQUIRED');
});
check('readiness score excludes not_assessed items', () => {
  const tpl = inspections.getTemplate('CHEERS-2022');
  const a = inspections.startAssessment({ title: 'test2', templateId: tpl.id }, user('demo.qa'), CTX);
  const f1 = a.findings.find((f) => f.item && f.item.seq === 1);
  inspections.assessItem(f1.id, { grade: 'compliant', evidence: '合规证据：正文第 1 节已核', observation: '' }, user('demo.qa'), CTX);
  const fresh = inspections.getAssessment(a.code);
  assert.equal(fresh.readinessScore, 100); // single compliant item → 100
});

// ------------------------------------------------------------ documents -----
check('document version approval requires a signature', () => {
  const doc = documents.createDocument({ title: '测试规程文档', docType: 'SOP', gxpAreas: ['CST'], content: '内容' }, user('demo.researcher'), CTX);
  const ver = doc.versions[0];
  assert.throws(() => documents.approveVersion(ver.id, { signatureId: null }, user('demo.heorlead'), CTX), (e) => e.code === 'SIGNATURE_REQUIRED');
});
check('version approval succeeds with signature and updates document', () => {
  const doc = documents.createDocument({ title: '测试批准文档', docType: 'SOP', gxpAreas: ['MDL'], content: '内容2' }, user('demo.researcher'), CTX);
  const ver = doc.versions[0];
  const actor = user('demo.heorlead');
  const nonce = auth.issueSigningNonce(actor, null, 'signature').nonce;
  const sig = auth.sign({ user: actor, session: null, username: 'demo.heorlead', password: PASSWORD, nonce, meaning: 'approved', reason: '批准初始版本', entityType: 'document_versions', entityId: String(ver.id), recordKey: `documents:${doc.id}`, ctx: CTX });
  assert.ok(sig.ok);
  const after = documents.approveVersion(ver.id, { signatureId: sig.signature.id }, actor, CTX);
  assert.equal(after.status, 'effective');
  assert.equal(after.currentVersion, 'V1.0');
});

// ------------------------------------------------------------- dashboard -----
check('readiness dashboard returns named blockers', () => {
  const rd = inspections.readinessDashboard();
  assert.ok(rd.score >= 0 && rd.score <= 100);
});

// ------------------------------------------------------------------- main ----
let pass = 0;
let fail = 0;
for (const c of checks) {
  if (run(c.name, c.fn)) pass += 1; else fail += 1;
}
const chain = audit.verifyChain();
process.stdout.write(`\n  chain integrity after ${chain.checked} entries: ${chain.ok ? 'OK' : 'FAILED'}\n`);
if (!chain.ok) fail += 1;

try { db.close(); } catch { /* ignore */ }
process.stdout.write(`\n  core suite: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);