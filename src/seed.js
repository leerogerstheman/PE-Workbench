'use strict';

/**
 * Seed loader for the PharmacoEconomics Workbench.
 *
 * Two distinct things are loaded at start-up:
 *
 *  1. The **analysis configuration library** - process-type definitions and
 *     assessment checklist templates (CHEERS 2022, China guideline, ISPOR-SMDM
 *     model validation, data integrity). These are configuration, not data:
 *     they describe how the site's pharmacoeconomic work is governed and are
 *     version controlled alongside the code. They are (re)loaded on every start
 *     so editing a JSON file is enough to change a workflow.
 *
 *  2. Reference data - the domain (专业领域) register.
 *
 * Demo records are deliberately NOT loaded here; `scripts/seed-demo.js` does
 * that explicitly, so a productive instance never accidentally gets fictitious
 * studies in its audit trail.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./core/db');
const workflow = require('./domain/workflow');
const inspections = require('./domain/inspections');

function nowIso() { return new Date().toISOString(); }

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(dir, f));
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
  }
}

/**
 * The domain register. Each entry is a professional field of pharmacoeconomic
 * work with its own methodological basis; the workbench treats them uniformly,
 * which is what lets one codebase govern a full HEOR pipeline.
 */
const PE_AREAS = [
  {
    code: 'RSD', name: '研究设计与方案', nameEn: 'Research Design & Analysis Plan',
    fullName: 'Research Design and Health Economic Analysis Plan',
    fullNameEn: 'Research Design and Health Economic Analysis Plan',
    description: '把要回答的决策问题写清楚：PICO、分析类型、视角、时间范围、贴现率、亚组与结局。方案先行，先想后算。方法学依据：ISPOR HEAP 良好实践报告、中国药物经济学评价指南（2020）第一章。',
    colour: '#2563eb',
  },
  {
    code: 'EVS', name: '证据检索与合成', nameEn: 'Evidence Search & Synthesis',
    fullName: 'Evidence Search and Synthesis',
    fullNameEn: 'Evidence Search and Synthesis',
    description: '系统文献综述（SLR）、间接治疗比较（ITC）与网络荟萃分析（NMA）。结论必须能溯源到已发表的证据。方法学依据：PRISMA 2020、ISPOR ITC 良好实践报告、Cochrane 手册。',
    colour: '#7c3aed',
  },
  {
    code: 'OUT', name: '健康效用与结局', nameEn: 'Utilities & Health Outcomes',
    fullName: 'Health Utilities and Outcomes',
    fullNameEn: 'Health Utilities and Outcomes',
    description: 'EQ-5D 等偏好型量表、效用评分、映射与 QALY 计算。结局是怎么打分的必须透明：量表、算法、来源人群。方法学依据：EQ-5D 指南、ISPOR 效用估值良好实践。',
    colour: '#0891b2',
  },
  {
    code: 'CST', name: '成本测算', nameEn: 'Costing & Resource Use',
    fullName: 'Costs and Resource Use',
    fullNameEn: 'Costs and Resource Use',
    description: '资源清单、单价核实、币种与价格日期、按视角的成本口径（医保支付方 / 全社会）。成本不是数字，是"谁付钱、按什么口径、以什么价格"。方法学依据：中国指南（2020）成本章节、ISPOR 成本良好实践。',
    colour: '#ea580c',
  },
  {
    code: 'MDL', name: '经济建模', nameEn: 'Economic Modeling',
    fullName: 'Economic Modeling',
    fullNameEn: 'Economic Modeling',
    description: '决策树、Markov 模型、分区生存模型、个体水平模拟。模型是一台必须透明的机器：结构、假设、参数、代码都要可审查。方法学依据：ISPOR-SMDM 建模良好实践任务组系列报告。',
    colour: '#db2777',
  },
  {
    code: 'ANA', name: '分析与解读', nameEn: 'Analysis & Interpretation',
    fullName: 'Analysis and Interpretation',
    fullNameEn: 'Analysis and Interpretation',
    description: '增量成本-效果比（ICER）、净货币收益、支付意愿阈值、敏感性分析与概率分析。不确定性不是缺陷——不展示不确定性才是。方法学依据：中国指南（2020）结果分析章节、CHEERS 2022 第 9/19/23 项。',
    colour: '#16a34a',
  },
  {
    code: 'RPT', name: '报告与申报', nameEn: 'Reporting & Submission',
    fullName: 'Reporting and Submission',
    fullNameEn: 'Reporting and Submission',
    description: '按 CHEERS 2022 / 中国指南（2020）规范撰写评估报告，向 HTA 机构、医保谈判、期刊递交材料。写不出来的分析等于没做。方法学依据：CHEERS 2022、中国药物经济学评价指南（2020）报告规范章节。',
    colour: '#0f766e',
  },
];

function loadPeAreas() {
  const at = nowIso();
  let added = 0;
  PE_AREAS.forEach((area, index) => {
    const existing = db.get('SELECT code FROM gxp_areas WHERE code = ?', [area.code]);
    db.run(
      'INSERT INTO gxp_areas (code, name, name_en, full_name, full_name_en, description, colour, sort_order) ' +
      'VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, name_en = excluded.name_en, ' +
      'full_name = excluded.full_name, full_name_en = excluded.full_name_en, description = excluded.description, ' +
      'colour = excluded.colour, sort_order = excluded.sort_order',
      [area.code, area.name, area.nameEn, area.fullName, area.fullNameEn, area.description, area.colour, index + 1]
    );
    if (!existing) added += 1;
  });
  return { total: PE_AREAS.length, added };
}

function loadProcessTypes() {
  const dir = path.join(config.seedDir, 'workflows');
  const files = listJsonFiles(dir);
  const loaded = [];
  const errors = [];
  for (const file of files) {
    try {
      const definition = readJson(file);
      const result = workflow.register(definition, path.basename(file));
      loaded.push({ code: result.code, file: path.basename(file), changed: result.changed });
    } catch (err) {
      errors.push({ file: path.basename(file), message: err.message });
    }
  }
  const knownFiles = new Set(files.map((f) => path.basename(f)));
  const allRows = db.all('SELECT code, source_file FROM process_types WHERE active = 1');
  const orphaned = allRows.filter((r) => r.source_file && !knownFiles.has(r.source_file));
  for (const row of orphaned) {
    db.run('UPDATE process_types SET active = 0 WHERE code = ?', [row.code]);
  }
  return { loaded, errors, deactivated: orphaned.length };
}

function loadChecklistTemplates() {
  const dir = path.join(config.seedDir, 'checklists');
  const files = listJsonFiles(dir);
  const loaded = [];
  const errors = [];
  for (const file of files) {
    try {
      const template = readJson(file);
      const result = inspections.registerTemplate(template, path.basename(file));
      loaded.push({ code: result.code, file: path.basename(file), items: result.items });
    } catch (err) {
      errors.push({ file: path.basename(file), message: err.message });
    }
  }
  const knownFiles = new Set(files.map((f) => path.basename(f)));
  const allRows = db.all('SELECT code, source_file FROM checklist_templates WHERE active = 1');
  const orphaned = allRows.filter((r) => r.source_file && !knownFiles.has(r.source_file));
  for (const row of orphaned) {
    db.run('UPDATE checklist_templates SET active = 0 WHERE code = ?', [row.code]);
  }
  return { loaded, errors, deactivated: orphaned.length };
}

function run(opts = {}) {
  const hadConfig = db.get('SELECT COUNT(*) AS n FROM process_types').n > 0;
  const areas = loadPeAreas();
  const processes = loadProcessTypes();
  const checklists = loadChecklistTemplates();

  const errors = [...processes.errors, ...checklists.errors];
  if (errors.length && opts.throwOnError) {
    throw new Error(errors.map((e) => `${e.file}: ${e.message}`).join('; '));
  }

  const summary = {
    bootstrapped: !hadConfig,
    peAreas: areas.total,
    processTypes: processes.loaded.length,
    checklistTemplates: checklists.loaded.length,
    checklistItems: checklists.loaded.reduce((a, b) => a + b.items, 0),
    errors,
  };

  if (!opts.silent) {
    process.stdout.write(`\n  Analysis configuration library\n`);
    process.stdout.write(`    Domains (areas)      ${summary.peAreas}\n`);
    process.stdout.write(`    Process types        ${summary.processTypes}\n`);
    process.stdout.write(`    Checklist templates  ${summary.checklistTemplates} (${summary.checklistItems} requirements)\n`);
    if (processes.deactivated) process.stdout.write(`    Deactivated          ${processes.deactivated} removed process type(s)\n`);
    if (checklists.deactivated) process.stdout.write(`    Deactivated          ${checklists.deactivated} removed checklist(s)\n`);
    if (errors.length) {
      process.stdout.write('\n  WARNINGS while loading configuration:\n');
      for (const e of errors) process.stdout.write(`    ${e.file}: ${e.message}\n`);
    }
    process.stdout.write('\n');
  } else if (errors.length) {
    process.stdout.write(`  [seed] ${errors.length} configuration file(s) failed to load:\n`);
    for (const e of errors) process.stdout.write(`         ${e.file}: ${e.message}\n`);
  }

  return summary;
}

module.exports = { run, PE_AREAS };