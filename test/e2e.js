'use strict';

/**
 * End-to-end HTTP tests: the API surface the frontend talks to.
 */

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-e2e-test-'));
process.env.PE_DATA_DIR = tmp;
process.env.PE_BUILTIN_ACCOUNTS = '1';
process.env.PE_MONITOR = '0';
process.env.PE_PORT = '8917';
process.env.PE_HOST = '127.0.0.1';

const server = require('../src/api/server');
const seed = require('../src/seed');
const db = require('../src/core/db');
const accounts = require('../src/domain/accounts');

const BASE = 'http://127.0.0.1:8917';
let pass = 0;
let fail = 0;

function ok(name) { pass += 1; process.stdout.write(`  ok  ${name}\n`); }
function bad(name, err) { fail += 1; process.stdout.write(`  FAIL ${name}: ${err.message}\n`); }

async function api(method, urlPath, body, cookie) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') || '' };
}

async function main() {
  db.open();
  seed.run({ silent: true });
  accounts.provision(null, { ip: '127.0.0.1', userAgent: 'test', sessionId: null });

  const httpServer = await server.start();
  server.markReady();
  process.stdout.write('  server listening\n');

  try {
    // public endpoints
    const health = await api('GET', '/api/health');
    if (health.status === 200 && health.data.ok) ok('health is public');
    else bad('health', new Error(`status ${health.status}`));

    const boot = await api('GET', '/api/bootstrap');
    if (boot.data.domains.length === 7 && boot.data.loginChoices.length === 11) ok('bootstrap exposes domains + personas');
    else bad('bootstrap', new Error('domain/persona counts'));

    const domains = await api('GET', '/api/domains');
    if (domains.status === 200 && domains.data.domains.length === 7) ok('domains public');
    else bad('domains', new Error('not public'));

    const workflowPage = await api('GET', '/api/workflows/MODEL');
    if (workflowPage.data.workflow.chain.length === 8) ok('workflow detail public with chain');
    else bad('workflow detail', new Error('chain length'));

    // auth gate
    const gated = await api('GET', '/api/records');
    if (gated.status === 401) ok('records requires auth');
    else bad('records gate', new Error(`status ${gated.status}`));

    // login + session
    const login = await api('POST', '/api/login', { username: 'demo.researcher', password: 'PE-Demo-2026!' });
    if (!login.data.ok) throw new Error('login failed: ' + (login.data.message || login.data.code));
    const cookie = login.setCookie.split(';')[0];
    ok('login works and sets session cookie');

    const me = await api('GET', '/api/me', null, cookie);
    if (me.data.user.role === 'heor_researcher') ok('session resolves to user');
    else bad('me', new Error('role mismatch'));

    // workflow completion via HTTP incl. signature
    const rec = await api('POST', '/api/records', {
      processCode: 'PROTO', title: 'e2e 测试方案',
      summary: 'e2e 测试记录', criticality: 'major', dueDate: '2027-12-31', product: 'X',
      data: { pico: 'P', analysisType: 'CEA', perspective: 'payer', timeHorizon: '5 年', discountRate: '5%' },
    }, cookie);
    if (rec.status !== 201) throw new Error('create record failed: ' + rec.status + ' ' + JSON.stringify(rec.data));
    const recordId = rec.data.record.id;
    const recordKey = rec.data.record.recordKey;

    const step = await api('POST', `/api/records/${recordId}/steps/draft_protocol/complete`, {
      formData: { pico: 'P', perspective: 'payer', timeHorizon: '5 年', discountRate: '5%', decisionContext: 'e2e' },
      comment: 'draft done',
    }, cookie);
    if (step.status === 200 && step.data.record.currentStep === 'methodology_review') ok('step completion advances workflow');
    else bad('step completion', new Error(`status ${step.status}`));

    // role separation via HTTP: researcher blocked from the review step
    const blocked = await api('POST', `/api/records/${recordId}/steps/methodology_review/complete`, {
      formData: { reviewComments: 'x', verdict: 'pass_with_comments' },
    }, cookie);
    if (blocked.status === 403) ok('role gate returns 403 over HTTP');
    else bad('role gate', new Error(`status ${blocked.status} ${JSON.stringify(blocked.data)}`));

    // the HEOR lead runs the review and signs the approval
    const leadLogin = await api('POST', '/api/login', { username: 'demo.heorlead', password: 'PE-Demo-2026!' });
    const leadCookie = leadLogin.setCookie.split(';')[0];

    const reviewed = await api('POST', `/api/records/${recordId}/steps/methodology_review/complete`, {
      formData: { reviewComments: 'e2e 评审', verdict: 'pass_with_comments' },
      comment: 'reviewed',
    }, leadCookie);
    if (reviewed.status !== 200) throw new Error('review failed: ' + reviewed.status + ' ' + JSON.stringify(reviewed.data));

    const challenge = await api('POST', '/api/signatures/challenge', {}, leadCookie);
    if (challenge.data.nonce) ok('signing challenge issued');
    else bad('challenge', new Error('no nonce'));

    const sig = await api('POST', '/api/signatures', {
      username: 'demo.heorlead', password: 'PE-Demo-2026!', nonce: challenge.data.nonce,
      meaning: 'approved', reason: 'e2e 批准方案',
      entityType: 'workflow_instances', entityId: String(recordId), recordKey, stepCode: 'approval',
    }, leadCookie);
    if (sig.data.ok !== false) ok('two-factor signature applied');
    else bad('signature', new Error(JSON.stringify(sig.data)));

    const approved = await api('POST', `/api/records/${recordId}/steps/approval/complete`, {
      formData: { approvalNotes: 'e2e 批准' },
      comment: 'approved',
      signatureId: sig.data.signature.id,
    }, leadCookie);
    if (approved.status !== 200) throw new Error('approval failed: ' + approved.status + ' ' + JSON.stringify(approved.data));
    if (approved.data.record.steps.find((s) => s.code === 'approval').status === 'completed') ok('signed step completed');
    else bad('signed step', new Error('approval step not completed'));

    // calculation
    const calc = await api('POST', '/api/analysis/cea', {
      label: 'e2e', costNew: 1000, costComp: 800, effectNew: 2, effectComp: 1, wtp: 500,
    }, cookie);
    if (calc.data.calculation.output.icer === 200) ok('CEA via HTTP');
    else bad('CEA HTTP', new Error(JSON.stringify(calc.data)));

    // analysis permission check: researcher allowed, coordinator denied
    const denied = await api('POST', '/api/analysis/cea', { costNew: 1, costComp: 0, effectNew: 1, effectComp: 0, wtp: 1 }, null);
    if (denied.status === 401) ok('unauthenticated calculation denied');
    else bad('calc gate', new Error(`status ${denied.status}`));

    // audit export requires permission
    const exportReq = await api('GET', '/api/audit/export', null, cookie);
    if (exportReq.status === 403) ok('audit export denied for researcher (no audit.export permission)');
    else bad('export gate', new Error(`status ${exportReq.status}`));

    // global quick search works for signed-in users and is denied anonymously
    const search = await api('GET', '/api/search?q=SLR', null, cookie);
    if (search.status === 200 && Array.isArray(search.data.results) && search.data.results.length > 0) ok('global search returns results');
    else bad('search', new Error(`status ${search.status} count=${search.data && search.data.results && search.data.results.length}`));
    const searchAnon = await api('GET', '/api/search?q=SLR', null, null);
    if (searchAnon.status === 401) ok('global search requires sign-in');
    else bad('search gate', new Error(`status ${searchAnon.status}`));

    // QA can see assessments
    const qaLogin = await api('POST', '/api/login', { username: 'demo.qa', password: 'PE-Demo-2026!' });
    const qaCookie = qaLogin.setCookie.split(';')[0];
    const assess = await api('POST', '/api/assessments', {
      title: 'e2e 评估', templateId: 1,
    }, qaCookie);
    if (assess.status === 201) ok('QA starts assessment');
    else bad('assessment start', new Error(`status ${assess.status}`));

    // dashboard (any signed-in user)
    const dash = await api('GET', '/api/dashboard', null, cookie);
    if (dash.status === 200 && typeof dash.data.dashboard.readiness.score === 'number') ok('dashboard works');
    else bad('dashboard', new Error(`status ${dash.status}`));

    // inbox
    const inbox = await api('GET', '/api/inbox', null, cookie);
    if (inbox.status === 200 && Array.isArray(inbox.data.items)) ok('inbox works');
    else bad('inbox', new Error(`status ${inbox.status}`));

    // logout clears session
    const logout = await api('POST', '/api/logout', {}, cookie);
    if (logout.status === 200 && /pe_session=;/.test(logout.setCookie)) ok('logout clears cookie');
    else bad('logout', new Error(logout.setCookie));

    // tamper-evidence: session cookie no longer accepted
    const afterLogout = await api('GET', '/api/me', null, cookie);
    if (afterLogout.status === 401) ok('revoked session refused');
    else bad('revoked session', new Error(`status ${afterLogout.status}`));

    // 404 for unknown path (anonymous, since the session is gone)
    const nope = await api('GET', '/api/nope', null, null);
    if (nope.status === 404) ok('unknown route is 404');
    else bad('404', new Error(`status ${nope.status}`));
  } catch (err) {
    bad('e2e run', err);
  } finally {
    try { httpServer.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  process.stdout.write(`\n  e2e suite: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });