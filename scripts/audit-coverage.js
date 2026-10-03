'use strict';

/*
 * Coverage audit: which domains actually have content, in each module?
 *
 *   node scripts/audit-coverage.js
 *
 * "The workbench supports MDL" and "there is something to look at for MDL"
 * are different claims. This reports the second one honestly: bare counts per
 * area per module.
 */

const db = require('../src/core/db');

function likeParam(area) {
  return `%"${area}"%`;
}

function count(table, area) {
  return db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE gxp_areas LIKE ?`, [likeParam(area)]).n;
}

function main() {
  db.open();
  process.stdout.write('\n  PE-Workbench - content coverage audit\n');
  process.stdout.write('  ====================================\n');

  const areas = db.all('SELECT code, name, name_en FROM gxp_areas ORDER BY sort_order, code');
  const header = [
    'area'.padEnd(24),
    'flows'.padStart(6),
    'steps'.padStart(7),
    'checklists'.padStart(11),
    'records'.padStart(8),
  ].join(' | ');
  process.stdout.write(`\n  ${header}\n  ${'-'.repeat(header.length)}\n`);

  for (const area of areas) {
    const flows = db.all('SELECT definitions_json FROM process_types WHERE active = 1 AND gxp_areas LIKE ?', [likeParam(area.code)]);
    const stepTotal = flows.reduce((sum, f) => {
      try { return sum + (JSON.parse(f.definitions_json).steps || []).length; } catch { return sum; }
    }, 0);
    const records = db.get('SELECT COUNT(*) AS n FROM workflow_instances WHERE gxp_areas LIKE ?', [likeParam(area.code)]).n;
    const templates = count('checklist_templates', area.code);
    process.stdout.write([
      `${area.code} ${area.name}`.padEnd(24),
      String(flows.length).padStart(6),
      String(stepTotal).padStart(7),
      String(templates).padStart(11),
      String(records).padStart(8),
    ].join(' | ') + '\n');
  }

  const totalFlows = db.get('SELECT COUNT(*) AS n FROM process_types WHERE active = 1').n;
  const totalTemplates = db.get('SELECT COUNT(*) AS n FROM checklist_templates WHERE active = 1').n;
  const totalRecords = db.get('SELECT COUNT(*) AS n FROM workflow_instances').n;
  process.stdout.write(`\n  Totals: ${totalFlows} workflows, ${totalTemplates} checklists, ${totalRecords} records\n`);
  process.stdout.write('  Configuration library: seed/workflows + seed/checklists (JSON, hot-reloaded).\n\n');

  db.close();
  process.exit(0);
}

if (require.main === module) main();