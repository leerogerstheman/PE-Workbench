'use strict';

/**
 * Pharmacoeconomic calculation engine.
 *
 * WHY IT EXISTS
 * -------------
 * The workbench is not a modelling tool - TreeAge, R and Excel stay the tools
 * of record. But the *summary* calculations that land in a report (ICER,
 * INMB, discounted QALYs, budget impact) deserve more than a scratch pad: they
 * are the numbers a reviewer will recompute. So this module provides a small
 * audited calculator: every run is stored, every input and output is written
 * to the audit trail, and the results page explains how to interpret them.
 *
 * Design notes
 * ------------
 *  - Numbers are kept as plain decimal; formatting happens in the UI.
 *  - Interpretation text is informational and cites the decision context
 *    (e.g. the 1-3x GDP per capita reference band used in China's pricing
 *    discussions) as a reference, never as an official threshold.
 *  - Every calculation creates an audit entry with the full input/output
 *    payload, so the report value can always be traced to its run.
 */

const db = require('../core/db');
const audit = require('../core/audit');

function nowIso() { return new Date().toISOString(); }

function toNum(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw httpError(400, 'INVALID_NUMBER', `${field} must be a number`);
  return n;
}

function money(n) {
  return Math.round(n * 100) / 100;
}

function percent(n) {
  return Math.round(n * 1000) / 10;
}

// ------------------------------------------------------------------ CEA -----

/**
 * Cost-effectiveness calculation.
 *
 * @param {object} input
 * @param {string} input.label        what this run is for (e.g. "PE-001 基础分析")
 * @param {number} input.costNew      total cost of the new intervention
 * @param {number} input.costComp     total cost of the comparator
 * @param {number} input.effectNew    total effect of the new intervention (QALYs/LYG/events avoided)
 * @param {number} input.effectComp   total effect of the comparator
 * @param {number} input.wtp          willingness-to-pay threshold per unit of effect
 * @param {string} [input.outcomeName] label of the effect unit, default "QALY"
 */
function calculateCEA(input, actor) {
  const label = String(input.label || '').trim() || `CEA 计算 ${new Date().toISOString().slice(0, 19)}`;
  const costNew = toNum(input.costNew, 'costNew');
  const costComp = toNum(input.costComp, 'costComp');
  const effectNew = toNum(input.effectNew, 'effectNew');
  const effectComp = toNum(input.effectComp, 'effectComp');
  const wtp = toNum(input.wtp, 'wtp');
  const outcome = String(input.outcomeName || 'QALY');

  const deltaCost = money(costNew - costComp);
  const deltaEffect = effectNew - effectComp;

  // ICER 只在"有实际权衡"时计算：占优（更省更有效）与被占优（更贵更差）
  // 时比值没有决策意义（CHEERS 2022 第 22 项：必须连同增量成本与增量效果报告）。
  let icer = null;
  if (deltaCost > 0 && deltaEffect > 0) {
    icer = money(deltaCost / deltaEffect);       // 更贵更有效：阈值判断
  } else if (deltaCost < 0 && deltaEffect < 0) {
    icer = money(deltaCost / deltaEffect);       // 更省更差：负 ICER（省钱的权衡）
  }

  const inmb = money(deltaEffect * wtp - deltaCost);
  let quadrant;
  if (deltaCost > 0 && deltaEffect > 0) quadrant = 'NE_tradeoff';          // 更贵更有效：阈值判断
  else if (deltaCost <= 0 && deltaEffect > 0) quadrant = 'SE_dominant';    // 更省更有效：占优
  else if (deltaCost >= 0 && deltaEffect < 0) quadrant = 'NW_dominated';   // 更贵更差：被占优
  else quadrant = 'SW_tradeoff';                                           // 更省更差：阈值判断（负 ICER）

  const interpretation = interpretCEA({ deltaCost, deltaEffect, icer, inmb, quadrant, wtp, outcome });

  const output = {
    deltaCost,
    deltaEffect,
    icer: icer == null ? null : icer,
    inmb,
    quadrant,
    interpretation,
    inputsSnapshot: { costNew, costComp, effectNew, effectComp, wtp, outcome },
  };
  return persist('cea', label, input, output, actor, input._ctx);
}

function interpretCEA({ deltaCost, deltaEffect, icer, inmb, quadrant, wtp, outcome }) {
  const fmt = (n) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const lines = [];
  if (quadrant === 'SE_dominant') {
    lines.push(`新方案在成本更低（-¥${fmt(-deltaCost)}）的同时获得更多${outcome}（+${fmt(deltaEffect)}），为占优方案（dominant）。`);
    lines.push('此时 ICER 无意义（增量成本为负，不计算比值），报 INMB 即可。');
  } else if (quadrant === 'NW_dominated') {
    lines.push(`新方案成本更高（+¥${fmt(deltaCost)}）且${outcome}更少（${fmt(deltaEffect)}），为被占优方案（dominated），不应被选择。`);
  } else if (deltaEffect === 0) {
    lines.push(`两组${outcome}相同（Δ效果 = 0），应选择成本更低者：差额 ¥${fmt(-deltaCost)}（净节省）。`);
  } else if (deltaCost < 0) {
    lines.push(`新方案成本更低（-¥${fmt(-deltaCost)}）但${outcome}减少（Δ = ${fmt(deltaEffect)}）：属于"省钱的权衡"，ICER 为负值，需结合决策语境解释，通常选择成本更低方案并记录结局损失。`);
  } else {
    lines.push(`新方案成本更高（+¥${fmt(deltaCost)}）且多获得 ${fmt(deltaEffect)} 个${outcome}，ICER = ¥${fmt(icer)}/${outcome}。`);
    lines.push(`INMB（阈值 ¥${fmt(wtp)}）= ¥${fmt(inmb)}：${inmb >= 0 ? '≥ 0，在该阈值下具有经济性' : '< 0，在该阈值下不具有经济性'}。`);
    lines.push('阈值本身需结合决策背景：国内定价讨论中常以 1-3 倍人均 GDP 作为参考区间，具体以主管部门的口径为准。');
  }
  lines.push('提示：ICER 是比值，必须与增量成本、增量效果一同报告（CHEERS 2022 第 22 项），并附敏感性分析。');
  return lines;
}

// ----------------------------------------------------------------- BIA ------

/**
 * Budget impact calculation over a horizon (default 5 years):
 *   annualCost = eligiblePopulation * patientsOnDrug * annualCostPerPatient.
 * The incremental impact subtracts the comparator cost mix.
 *
 * @param {object} input
 * @param {number} input.population       eligible population (per year cohort)
 * @param {number[]} input.shareNew       market share of new drug per year (0-1)
 * @param {number} input.costNewPerPatient annual cost per patient of the new drug
 * @param {number} input.costCompPerPatient annual cost per patient of the comparator mix
 * @param {number} [input.horizonYears]   default 5
 * @param {string} [input.label]
 */
function calculateBIA(input, actor) {
  const label = String(input.label || '').trim() || `BIA 计算 ${new Date().toISOString().slice(0, 19)}`;
  const population = toNum(input.population, 'population');
  const costNew = toNum(input.costNewPerPatient, 'costNewPerPatient');
  const costComp = toNum(input.costCompPerPatient, 'costCompPerPatient');
  const horizon = Math.min(10, Math.max(1, Math.round(toNum(input.horizonYears, 'horizonYears') || 5)));
  const shares = Array.isArray(input.shareNew) && input.shareNew.length ? input.shareNew.slice(0, horizon) : [];
  for (let i = shares.length; i < horizon; i += 1) shares.push(shares[i - 1] || 0);

  const years = [];
  for (let y = 0; y < horizon; y += 1) {
    const share = Math.min(1, Math.max(0, toNum(shares[y], `shareNew[${y}]`)));
    const onNew = population * share;
    const onComp = population - onNew;
    const totalNew = money(onNew * costNew + onComp * costComp);
    const totalComp = money(population * costComp);
    years.push({
      year: y + 1, share: percent(share), patientsOnNew: Math.round(onNew),
      totalCost: totalNew, comparatorCost: totalComp,
      incremental: money(totalNew - totalComp),
    });
  }
  const totalIncremental = money(years.reduce((s, y) => s + y.incremental, 0));
  const output = {
    horizonYears: horizon,
    years,
    totalIncremental,
    interpretation: [
      `测算 ${horizon} 年内医保基金累计增量支出约 ¥${totalIncremental.toLocaleString('zh-CN')}。`,
      'BIA 按《中国药物经济学评价指南》应为增量视角：以替代现有治疗组合后的净变化计。',
      '人群规模、市场份额与价格是三大杠杆，均须做敏感性分析（ISPOR BIA 良好实践）。',
    ],
  };
  return persist('bia', label, input, output, actor, input._ctx);
}

// ---------------------------------------------------------------- QALY ------

/**
 * Discounted QALY accumulation across health-state cycles.
 * Each cycle: { utility, years } -> contribution = utility * years / (1+r)^t.
 *
 * @param {object} input
 * @param {number} input.discountRate      annual discount rate (e.g. 0.03)
 * @param {Array<{utility: number, years: number}>} input.cycles
 */
function calculateQALY(input, actor) {
  const label = String(input.label || '').trim() || `QALY 计算 ${new Date().toISOString().slice(0, 19)}`;
  const rate = toNum(input.discountRate, 'discountRate');
  if (rate < 0 || rate > 0.2) throw httpError(400, 'DISCOUNT_RATE_RANGE', 'discountRate should be between 0 and 0.2');
  const cycles = Array.isArray(input.cycles) ? input.cycles : [];
  if (!cycles.length) throw httpError(400, 'CYCLES_REQUIRED', 'Provide at least one {utility, years} cycle');

  let t = 0;
  const rows = [];
  let undiscounted = 0;
  let discounted = 0;
  for (const c of cycles) {
    const utility = Math.min(1, Math.max(0, toNum(c.utility, 'utility')));
    const years = Math.max(0, toNum(c.years, 'years'));
    const raw = utility * years;
    const pv = raw / Math.pow(1 + rate, t);
    undiscounted += raw;
    discounted += pv;
    rows.push({ t, utility, years, qalyDiscounted: money(pv), qalyUndiscounted: money(raw) });
    t += years;
  }
  const rounded = money(discounted);
  const output = {
    discountRate: rate,
    cycles: rows,
    totalQalyDiscounted: rounded,
    totalQalyUndiscounted: money(undiscounted),
    interpretation: [
      `贴现率 ${percent(rate * 100)}% 下合计 ${rounded} QALY（未贴现 ${money(undiscounted)}）。`,
      '效用值必须注明量表与价值集来源（CHEERS 2022 第 12 项）；1.0 = 完全健康，0 = 死亡。',
    ],
  };
  return persist('qaly', label, input, output, actor, input._ctx);
}

// ------------------------------------------------------------- persist ------

function persist(kind, label, input, output, actor, ctx) {
  const now = nowIso();
  const storedInput = { ...input };
  delete storedInput._ctx;
  const res = db.run(
    'INSERT INTO analysis_calculations (label, kind, input_json, output_json, created_at, created_by) VALUES (?,?,?,?,?,?)',
    [label, kind, JSON.stringify(storedInput), JSON.stringify(output), now, actor ? actor.id : null]
  );
  const id = db.get('SELECT last_insert_rowid() AS id').id;
  audit.append({
    action: 'analysis_calculated',
    entityType: 'analysis_calculations',
    entityId: id,
    actor: actor || null,
    reason: `${label} (${kind})`,
    ctx: ctx || {},
    meta: { kind },
    newValue: { label, kind, input: storedInput, output },
    severity: 'info',
  });
  return { id, kind, label, createdAt: now, input: storedInput, output };
}

function listCalculations(limit = 50) {
  const rows = db.all(
    'SELECT * FROM analysis_calculations ORDER BY id DESC LIMIT ?',
    [Math.min(Number(limit) || 50, 200)]
  );
  return rows.map((r) => ({
    id: r.id, label: r.label, kind: r.kind,
    input: safeParse(r.input_json), output: safeParse(r.output_json),
    createdAt: r.created_at, createdBy: r.created_by,
  }));
}

function getCalculation(id) {
  const row = db.get('SELECT * FROM analysis_calculations WHERE id = ?', [Number(id)]);
  if (!row) return null;
  return {
    id: row.id, label: row.label, kind: row.kind,
    input: safeParse(row.input_json), output: safeParse(row.output_json),
    createdAt: row.created_at, createdBy: row.created_by,
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  calculateCEA,
  calculateBIA,
  calculateQALY,
  listCalculations,
  getCalculation,
  httpError,
};