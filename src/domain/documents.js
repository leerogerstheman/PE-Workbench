'use strict';

/**
 * Document control for the pharmacoeconomics workbench.
 *
 * What is controlled here: study protocols' SOPs, analysis plans (HEAP),
 * report templates, methodology manuals, dossiers. The discipline is the same
 * as in any regulated document system: versions are immutable, approval is
 * signed, periodic review is scheduled and overdue review shows up in the
 * readiness score.
 *
 * The methodological anchor is ALCOA+ ("Enduring") plus the GxP document
 * control practice (EU GMP Chapter 4, Annex 11 §4.2) that analysis teams
 * inherit when their outputs feed HTA submissions.
 */

const db = require('../core/db');
const audit = require('../core/audit');
const workflow = require('./workflow');

function nowIso() { return new Date().toISOString(); }

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

const DOC_TYPES = ['SOP', 'PROTOCOL', 'REPORT', 'TEMPLATE', 'MANUAL', 'DOSSIER'];
const DOC_STATUS = ['draft', 'in_review', 'approved', 'effective', 'obsolete'];

// -------------------------------------------------------------- document ----

function nextDocNumber(type) {
  const year = new Date().getFullYear();
  const prefix = 'PE' + (type || 'DOC').toUpperCase().slice(0, 3);
  const row = db.get(
    "SELECT doc_number FROM documents WHERE doc_number LIKE ? ORDER BY doc_number DESC LIMIT 1",
    [`${prefix}-${year}-%`]
  );
  let next = 1;
  if (row) {
    const tail = Number.parseInt(row.doc_number.split('-').pop(), 10);
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

function createDocument(input, actor, ctx) {
  const type = String(input.docType || 'PROTOCOL').toUpperCase();
  if (!DOC_TYPES.includes(type)) throw httpError(400, 'UNKNOWN_DOC_TYPE', `docType must be one of ${DOC_TYPES.join(', ')}`);
  const title = String(input.title || '').trim();
  if (title.length < 3) throw httpError(400, 'TITLE_REQUIRED');
  const docNumber = nextDocNumber(type);
  const now = nowIso();
  const reviewMonths = Number(input.reviewPeriodMonths) || 24;
  const nextReview = new Date(Date.now() + reviewMonths * 30 * 86400000).toISOString().slice(0, 10);
  let id;
  db.transaction(() => {
    const res = db.run(
      'INSERT INTO documents (doc_number, title, title_en, doc_type, gxp_areas, department, owner_id, current_version, ' +
      'status, review_period_months, next_review_date, summary, created_at, updated_at, created_by) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [docNumber, title, input.titleEn || null, type, JSON.stringify(input.gxpAreas || []),
        input.department || null, input.ownerId || (actor ? actor.id : null), null,
        'draft', reviewMonths, nextReview, input.summary || null, now, now, actor ? actor.id : null]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;
    if (input.content) {
      createVersion({ documentId: id, version: 'V1.0', changeSummary: '初始版本', changeReason: '初始版本（Initial version）', content: input.content }, actor, ctx);
    }
  });
  audit.append({
    action: 'create', entityType: 'documents', entityId: id, recordKey: `documents:${id}`,
    actor, reason: input.summary || `Document ${docNumber} created`, ctx,
    gxpAreas: input.gxpAreas || [],
    newValue: { doc_number: docNumber, title, doc_type: type },
  });
  return getDocument(id);
}

function listDocuments(filters = {}) {
  const where = [];
  const params = [];
  if (filters.docType) { where.push('doc_type = ?'); params.push(filters.docType); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.gxpArea) { where.push('gxp_areas LIKE ?'); params.push(`%"${filters.gxpArea}"%`); }
  if (filters.ownerId) { where.push('owner_id = ?'); params.push(Number(filters.ownerId)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(`SELECT * FROM documents ${clause} ORDER BY updated_at DESC LIMIT 200`, params);
  return rows.map((r) => {
    const versions = db.all('SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at DESC', [r.id]);
    return {
      id: r.id, docNumber: r.doc_number, title: r.title, titleEn: r.title_en,
      docType: r.doc_type, gxpAreas: parseJson(r.gxp_areas, []), department: r.department,
      ownerId: r.owner_id, currentVersion: r.current_version, status: r.status,
      reviewPeriodMonths: r.review_period_months, nextReviewDate: r.next_review_date,
      reviewOverdue: r.next_review_date ? Date.parse(r.next_review_date) < Date.now() : false,
      summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at,
      versionCount: versions.length,
    };
  });
}

function getDocument(idOrNumber) {
  const row = /^\d+$/.test(String(idOrNumber))
    ? db.get('SELECT * FROM documents WHERE id = ?', [Number(idOrNumber)])
    : db.get('SELECT * FROM documents WHERE doc_number = ?', [String(idOrNumber)]);
  if (!row) return null;
  const versions = db.all('SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at ASC', [row.id]);
  return {
    id: row.id, docNumber: row.doc_number, title: row.title, titleEn: row.title_en,
    docType: row.doc_type, gxpAreas: parseJson(row.gxp_areas, []), department: row.department,
    ownerId: row.owner_id, currentVersion: row.current_version, status: row.status,
    reviewPeriodMonths: row.review_period_months, nextReviewDate: row.next_review_date,
    reviewOverdue: row.next_review_date ? Date.parse(row.next_review_date) < Date.now() : false,
    summary: row.summary, createdAt: row.created_at, updatedAt: row.updated_at,
    versions: versions.map((v) => ({
      id: v.id, version: v.version, status: v.status, changeSummary: v.change_summary,
      changeReason: v.change_reason, content: v.content, effectiveDate: v.effective_date,
      obsoleteDate: v.obsolete_date, reviewDueDate: v.review_due_date,
      createdAt: v.created_at, createdBy: v.created_by,
    })),
  };
}

function createVersion({ documentId, version, changeSummary, changeReason, content }, actor, ctx) {
  const doc = db.get('SELECT * FROM documents WHERE id = ?', [Number(documentId)]);
  if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');
  if (!changeReason || String(changeReason).trim().length < 3) {
    throw httpError(400, 'REASON_REQUIRED', 'Every new document version needs a stated change reason');
  }
  const ver = String(version || '').trim() || nextVersionOf(doc.current_version);
  const exists = db.get('SELECT id FROM document_versions WHERE document_id = ? AND version = ?', [doc.id, ver]);
  if (exists) throw httpError(409, 'VERSION_EXISTS', `Version ${ver} already exists`);
  const now = nowIso();
  let id;
  db.transaction(() => {
    const res = db.run(
      'INSERT INTO document_versions (document_id, version, status, change_summary, change_reason, content, content_hash, created_at, created_by) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
      [doc.id, ver, 'draft', changeSummary || null, changeReason, content || null,
        content ? require('../core/crypto').sha256(content) : null, now, actor ? actor.id : null]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;
    db.run('UPDATE documents SET updated_at = ? WHERE id = ?', [now, doc.id]);
  });
  audit.append({
    action: 'version_created', entityType: 'document_versions', entityId: id,
    recordKey: `documents:${doc.id}`, actor, reason: changeReason, ctx,
    gxpAreas: parseJson(doc.gxp_areas, []),
    newValue: { doc_number: doc.doc_number, version: ver, change_summary: changeSummary },
  });
  return getDocument(doc.id);
}

function nextVersionOf(current) {
  if (!current) return 'V1.0';
  const m = /^V(\d+)\.(\d+)$/.exec(current);
  if (!m) return `${current}.1`;
  return `V${m[1]}.${Number(m[2]) + 1}`;
}

/**
 * Approve a version with an e-signature. Signing the approval means the version
 * becomes the document's current version and becomes effective.
 */
function approveVersion(versionId, { signatureId }, actor, ctx) {
  const ver = db.get('SELECT * FROM document_versions WHERE id = ?', [Number(versionId)]);
  if (!ver) throw httpError(404, 'VERSION_NOT_FOUND');
  if (!signatureId) throw httpError(428, 'SIGNATURE_REQUIRED', 'Approving a document version requires an electronic signature');
  const sig = db.get('SELECT * FROM signatures WHERE id = ?', [Number(signatureId)]);
  if (!sig || !sig.valid) throw httpError(409, 'SIGNATURE_INVALID');
  if (sig.user_id !== actor.id) throw httpError(403, 'SIGNATURE_NOT_YOURS');
  const now = nowIso();
  db.transaction(() => {
    db.run(
      'UPDATE document_versions SET status = ?, effective_date = ?, review_due_date = ? WHERE id = ?',
      ['effective', now, addMonths(now, 24), ver.id]
    );
    db.run(
      'UPDATE documents SET current_version = ?, status = ?, next_review_date = ?, updated_at = ? WHERE id = ?',
      [ver.version, 'effective', addMonths(now, 24).slice(0, 10), now, ver.document_id]
    );
  });
  audit.append({
    action: 'version_approved', entityType: 'document_versions', entityId: ver.id,
    recordKey: `documents:${ver.document_id}`, actor, reason: sig.reason, ctx,
    signatureId: sig.id, severity: 'critical',
    gxpAreas: parseJson((db.get('SELECT * FROM documents WHERE id = ?', [ver.document_id]) || {}).gxp_areas, []),
    newValue: { version: ver.version, status: 'effective' },
  });
  return getDocument(ver.document_id);
}

function acknowledgeRead(documentId, versionId, actor, ctx) {
  const doc = db.get('SELECT * FROM documents WHERE id = ?', [Number(documentId)]);
  if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');
  const now = nowIso();
  db.run(
    'INSERT INTO documents_read (document_id, version_id, user_id, read_at, acknowledged) VALUES (?,?,?,?,1) ' +
    'ON CONFLICT(document_id, version_id, user_id) DO UPDATE SET read_at = excluded.read_at, acknowledged = 1',
    [doc.id, versionId || null, actor.id, now]
  );
  audit.append({
    action: 'document_read', entityType: 'documents', entityId: doc.id,
    recordKey: `documents:${doc.id}`, actor, reason: 'Read and acknowledged', ctx,
    meta: { versionId: versionId || null },
  });
  return getDocument(doc.id);
}

function markObsolete(documentId, reason, actor, ctx) {
  const doc = db.get('SELECT * FROM documents WHERE id = ?', [Number(documentId)]);
  if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');
  if (!reason || String(reason).trim().length < 10) {
    throw httpError(400, 'REASON_REQUIRED', 'Obsoleting a document requires a justification of at least 10 characters');
  }
  db.run('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?', ['obsolete', nowIso(), doc.id]);
  db.run('UPDATE document_versions SET obsolete_date = ? WHERE document_id = ? AND status = ?', [nowIso(), doc.id, 'effective']);
  audit.append({
    action: 'document_obsoleted', entityType: 'documents', entityId: doc.id,
    recordKey: `documents:${doc.id}`, actor, reason, ctx, severity: 'warning',
    oldValue: { status: doc.status }, newValue: { status: 'obsolete' },
  });
  return getDocument(doc.id);
}

function addMonths(iso, months) {
  const d = new Date(Date.parse(iso));
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  DOC_TYPES,
  createDocument,
  listDocuments,
  getDocument,
  createVersion,
  approveVersion,
  acknowledgeRead,
  markObsolete,
  nextDocNumber,
  httpError,
};