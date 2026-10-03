'use strict';

/**
 * Central runtime configuration for the PharmacoEconomics Workbench.
 *
 * Everything is overridable through environment variables so the same build can
 * run on a workstation, a review machine or a shared submission terminal.
 * The environment prefix is `PE_` (PharmacoEconomics).
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = process.env.PE_DATA_DIR
  ? path.resolve(process.env.PE_DATA_DIR)
  : path.join(ROOT, 'data');

for (const dir of [dataDir, path.join(ROOT, 'exports'), path.join(ROOT, 'backups')]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const config = {
  app: {
    name: 'PE-Workbench',
    nameZh: '药物经济学工作台',
    version: require('../package.json').version,
    /** Schema version, stamped into every database for upgrade bookkeeping. */
    schemaVersion: 1,
  },

  root: ROOT,
  dataDir,
  exportDir: path.join(ROOT, 'exports'),
  backupDir: path.join(ROOT, 'backups'),
  webDir: path.join(ROOT, 'web'),
  seedDir: path.join(ROOT, 'seed'),
  dbFile: process.env.PE_DB_FILE
    ? path.resolve(process.env.PE_DB_FILE)
    : path.join(dataDir, 'pe.db'),

  http: {
    host: process.env.PE_HOST || '127.0.0.1',
    port: envInt('PE_PORT', 8798),
    /** Set PE_TRUST_PROXY=1 when published behind a reverse proxy. */
    trustProxy: process.env.PE_TRUST_PROXY === '1',
    maxBodyBytes: envInt('PE_MAX_BODY', 8 * 1024 * 1024),
  },

  security: {
    // Data-integrity / ALCOA+ inspired account controls (21 CFR Part 11 §11.300,
    // EU GMP Annex 11 §12 - the same discipline applies to analysis records).
    passwordMinLength: envInt('PE_PASSWORD_MIN', 10),
    passwordHistoryDepth: envInt('PE_PASSWORD_HISTORY', 5),
    passwordMaxAgeDays: envInt('PE_PASSWORD_MAX_AGE', 90),
    passwordRequireClasses: envInt('PE_PASSWORD_CLASSES', 3),
    maxFailedLogins: envInt('PE_MAX_FAILED_LOGINS', 5),
    lockoutMinutes: envInt('PE_LOCKOUT_MINUTES', 15),
    idleTimeoutMinutes: envInt('PE_IDLE_TIMEOUT', 30),
    sessionAbsoluteHours: envInt('PE_SESSION_ABSOLUTE_HOURS', 12),
    signatureTtlMinutes: envInt('PE_SIGNATURE_TTL', 5),
    signingNonceTtlSeconds: envInt('PE_NONCE_TTL', 120),
    totpIssuer: 'PE-Workbench',
  },

  /** Days ahead that "expiring soon" warnings cover. */
  reminder: {
    documentReviewWarningDays: envInt('PE_DOC_REVIEW_WARN_DAYS', 30),
    trainingExpiryWarningDays: envInt('PE_TRAINING_WARN_DAYS', 30),
    recordDueWarningDays: envInt('PE_RECORD_WARN_DAYS', 7),
  },

  /** Chain verification uses a keyed digest so audit rows cannot be recomputed
   *  by someone who merely copies the database file. */
  audit: {
    get hmacKey() {
      const f = path.join(dataDir, 'audit-chain.key');
      if (!fs.existsSync(f)) {
        fs.writeFileSync(f, require('node:crypto').randomBytes(48).toString('hex'), { mode: 0o600 });
      }
      return fs.readFileSync(f, 'utf8').trim();
    },
  },

  /** Runtime feature switches. */
  features: {
    /** Require a TOTP code (second factor) for e-signatures on analysis records. */
    signatureSecondFactor: process.env.PE_SIG_2FA !== '0',
    /** Block completion of records whose linked steps are incomplete. */
    strictWorkflowGating: process.env.PE_STRICT_GATING !== '0',
    /** Refuse mutations when the audit chain is broken. */
    freezeOnChainBreak: process.env.PE_FREEZE_ON_CHAIN_BREAK !== '0',
    /**
     * Provision the built-in demonstration personas at start-up and show them on
     * the login screen. OFF by default: an instance that will hold real analysis
     * records must never ship with known credentials.
     */
    builtinAccounts: process.env.PE_BUILTIN_ACCOUNTS === '1',
    /**
     * Generate the demonstration dataset at start-up when the instance holds no
     * records yet, so one double-click gives a populated workbench.
     * Gated on built-in accounts: the dataset is fictional studies and
     * signatures written into the real audit trail.
     */
    autoSeedDemo: process.env.PE_AUTO_SEED_DEMO !== '0'
      && process.env.PE_BUILTIN_ACCOUNTS === '1',
    /** Run the background workflow monitor as a child of the server process. */
    backgroundMonitor: process.env.PE_MONITOR !== '0',
  },
};

module.exports = config;