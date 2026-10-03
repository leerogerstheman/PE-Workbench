'use strict';

/**
 * Demo / training dataset generator.
 *
 *   node scripts/seed-demo.js                 populate an empty instance
 *   node scripts/seed-demo.js --force         allow adding to a populated instance
 *
 * WHY THIS IS NOT PART OF seed.js
 * -------------------------------
 * `seed.js` loads the *configuration library* (workflow definitions, checklist
 * templates, domains). This script writes FICTIONAL analysis records - studies,
 * models, signatures, calculations - into the real audit trail. A productive
 * instance must never find invented records waiting in it, so this runs only
 * when built-in accounts are enabled (PE_BUILTIN_ACCOUNTS=1).
 *
 * THE SCENARIO
 * ------------
 * 虚构企业「康济医药（演示）」正在为虚构肿瘤新药 PE-001（晚期非小细胞肺癌
 * 二线）做医保准入前的成本-效用分析。每个记录停在流程的不同阶段，让首次
 * 使用者一进来就看到：有的等审、有的超期、有的有严重缺陷、有的验证没过。
 * 全部人名、药名、数字均为虚构。
 */

const path = require('node:path');
const db = require('../src/core/db');
const audit = require('../src/core/audit');
const workflow = require('../src/domain/workflow');
const inspections = require('../src/domain/inspections');
const documents = require('../src/domain/documents');
const analysis = require('../src/domain/analysis');
const accounts = require('../src/domain/accounts');
const auth = require('../src/core/auth');

const PASSWORD = accounts.BUILTIN_PASSWORD;
const CONTEXT = { ip: '127.0.0.1', userAgent: 'seed-demo', sessionId: null };

let created = { users: 0, records: 0, steps: 0, signatures: 0, documents: 0, assessments: 0, findings: 0, calculations: 0 };

// ---------------------------------------------------------------- helpers ----

function parseArgs(argv) {
  const opts = { force: false, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--force') opts.force = true;
    if (argv[i] === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

function user(username) {
  const row = db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!row) throw new Error(`persona ${username} not found - run the server once first (it provisions personas)`);
  return { ...row, _ctx: CONTEXT };
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** Apply a signature over a workflow step and mark its record's step complete. */
function signAndComplete(instance, stepCode, username, meaning, reason, formData, comment) {
  const actor = user(username);
  const stepDef = (workflow.getDefinition(instance.processCode).steps || []).find((s) => s.code === stepCode);
  const expected = stepDef && stepDef.signatureMeaning;
  if (expected && expected !== meaning) {
    throw new Error(`step ${stepCode} declares signatureMeaning "${expected}" but caller wants "${meaning}"`);
  }
  let signatureId = null;
  if (meaning) {
    const nonce = auth.issueSigningNonce(actor, null, 'signature').nonce;
    const res = auth.sign({
      user: actor,
      session: null,
      username: actor.username,
      password: PASSWORD,
      nonce,
      meaning,
      reason,
      entityType: 'workflow_instances',
      entityId: String(instance.id),
      recordKey: instance.recordKey,
      stepCode,
      ctx: CONTEXT,
    });
    if (!res.ok) throw new Error(`sign failed for ${instance.recordKey}/${stepCode}: ${res.code}`);
    signatureId = res.signature.id;
    created.signatures += 1;
  }
  const after = workflow.completeStep({
    instanceId: instance.id,
    stepCode,
    actor,
    ctx: CONTEXT,
    outcome: 'completed',
    comment: comment || reason,
    formData: formData || {},
    signatureId: signatureId || undefined,
  });
  created.steps += 1;
  return after;
}

function completeTask(instance, stepCode, username, formData, comment) {
  return signAndComplete(instance, stepCode, username, null, comment || '完成步骤', formData);
}

function makeRecord(processCode, username, title, extra = {}) {
  const actor = user(username);
  const rec = workflow.createInstance({
    processCode,
    title,
    summary: extra.summary || title,
    criticality: extra.criticality || 'major',
    ownerId: actor.id,
    product: extra.product || 'PE-001（虚构）',
    dueDate: extra.dueDate || daysFromNow(30),
    gxpAreas: extra.gxpAreas,
    data: extra.data || {},
  }, actor, CONTEXT);
  created.records += 1;
  return rec;
}

// ------------------------------------------------------------------- main ----

function main() {
  const opts = parseArgs(process.argv);
  db.open();

  if (!db.get('SELECT COUNT(*) AS n FROM process_types').n) {
    process.stderr.write('  [seed-demo] configuration library is empty - run node scripts/seed.js first\n');
    db.close();
    process.exit(1);
  }

  const hasRecords = db.get('SELECT COUNT(*) AS n FROM workflow_instances').n > 0;
  if (hasRecords && !opts.force) {
    process.stderr.write('  [seed-demo] instance already holds records; use --force to add more\n');
    db.close();
    process.exit(1);
  }

  process.stdout.write('\n  PE-Workbench - demonstration dataset\n');
  process.stdout.write('  This creates FICTIONAL analysis records (studies, models, signatures).\n');

  // ------------------------------------------------------------ personas ----
  for (const persona of accounts.PERSONAS) {
    accounts.ensurePersona(persona, CONTEXT);
    created.users += 1;
  }

  // ------------------------------------------------ a closed, approved HEAP --
  const proto = makeRecord('PROTO', 'demo.researcher',
    'PE-001 二线晚期非小细胞肺癌成本-效用分析研究方案（HEAP）', {
      criticality: 'critical', dueDate: daysFromNow(-60),
      data: {
        pico: 'P：二线晚期非小细胞肺癌成年患者（功能状态 PS 0-1）；I：PE-001（虚构 TKI）；C：多西他赛；O：QALY、总生存、无进展生存、直接医疗成本',
        analysisType: 'cost-utility (CUA)', perspective: 'payer (医保支付方)', timeHorizon: '终身（最大 10 年）', discountRate: '5%（基础）',
      },
    });
  completeTask(proto, 'draft_protocol', 'demo.researcher', {
    pico: 'P：二线晚期非小细胞肺癌成年患者（功能状态 PS 0-1）；I：PE-001；C：多西他赛；O：QALY',
    perspective: 'payer (医保支付方)',
    timeHorizon: '终身（最大 10 年）；理由：进展后生存期需外推至终身',
    discountRate: '5%（基础）',
    decisionContext: '支持 PE-001 进入国家医保目录谈判：回答"以什么价格谈判使新药对基金具有经济性"。',
    dataSources: 'III 期随机对照试验（虚构 CTR-2024-011）；文献综述；省际挂网价目录',
  }, '方案完成起草，PICO 与数据来源明确');
  completeTask(proto, 'methodology_review', 'demo.heorlead', {
    reviewComments: '1) 时间范围终身合理，需注明外推方法；2) 视角为医保支付方，成本口径需与谈判文件一致；3) 基线贴现率 5% 与指南一致。',
    verdict: 'pass_with_comments',
  }, '方法学评审通过（意见已纳入）');
  signAndComplete(proto, 'approval', 'demo.heorlead', 'approved',
    '批准该方案：PICO、视角、时间范围、贴现率构成后续分析与报告的基线', {}, '方案批准');
  signAndComplete(proto, 'closure', 'demo.qa', 'closed',
    '方案、评审意见与批准记录已归档；后续偏离须走变更控制', {
      finalCheck: '归档文件齐全：方案 V1.0、评审记录、批准签名',
      filesRef: 'PROTO-2026-0001 档案盒 / DB 审计链 seq 引用',
    }, '结案归档');

  // ------------------------------------------------------------ SLR in QA --
  const slr = makeRecord('SLR', 'demo.evidence',
    'PE-001 二线 NSCLC 疗效与安全性系统文献综述', {
      criticality: 'major', dueDate: daysFromNow(9),
    });
  completeTask(slr, 'search_protocol', 'demo.evidence', {
    databases: 'PubMed / Embase / CNKI / CBM',
    searchTerms: '("NSCLC" OR "non-small cell lung") AND (second-line OR 二线) AND (randomized OR RCT) AND PE-001 相关注册名',
    inclusionCriteria: '纳入：≥II 期 RCT、成人、二线及以上、报告 OS/PFS；排除：单臂、摘要会议(无全文)、非英文/中文',
    slrType: 'comparator landscape',
  }, '检索策略获批');
  completeTask(slr, 'screening', 'demo.evidence', {
    screenedCount: '1,284', includedCount: '17',
    excludedReasons: '非随机 612；人群不符 398；无结局数据 157；重复 100',
    prismaRef: 'PRISMA 流程图 2026-02-10 版',
  }, '双重筛选完成');
  completeTask(slr, 'extraction', 'demo.evidence', {
    extractionTable: 'E-Table v2.1（17 篇：样本/治疗/随访/OS/PFS/HR）',
    doubleExtraction: 'yes', discrepancies: '7 处分歧全部仲裁记录于 E-Table 备注',
  }, '数据提取完成');
  signAndComplete(slr, 'quality_assessment', 'demo.stat', 'completed',
    '质量评估完成', {
      qualityTool: 'Cochrane RoB 2',
      qualityResult: '17 篇中 12 篇低风险、3 篇有担忧、2 篇高风险（未纳入综合）',
      exclusionsByQuality: '2 篇因高偏倚风险仅作敏感性参考',
    }, '质量评估完成（含 2 篇排除）');
  // 停在 synthesis 前——还原真实进度：质量评估刚完成，等着证据综合。

  // -------------------------------------------- ITC waits for consistency ---
  const itc = makeRecord('ITC', 'demo.evidence',
    'PE-001 与多西他赛间接比较（Bucher）——证据网络分析', {
      criticality: 'major', dueDate: daysFromNow(-5),
    });
  completeTask(itc, 'protocol', 'demo.evidence', {
    network: 'PE-001 —（无头对头）— 多西他赛；共同桥接：最佳支持治疗(BSC)试验连接',
    method: 'Bucher ITC', priors: '不适用（频率学派）',
    transitivity: '桥接试验之间的人群（均二线 NSCLC PS 0-1）、对照（BSC）、随访时长同质性可接受',
    software: 'R 4.4 / metafor 4.6',
  }, '分析方案确认');
  completeTask(itc, 'analysis', 'demo.stat', {
    results: 'OS HR 0.74（95%CI 0.61-0.90）；PFS HR 0.68（95%CI 0.56-0.84）',
    convergence: '不适用（频率学派 Bucher）',
    scriptRef: 'itc_bucher_2026-02.R（git rev a3f9c2）',
  }, '数据分析完成');
  // waiting for consistency check (overdue - 5d)

  // --------------------------------------------------- utility study at map --
  const utl = makeRecord('UTL', 'demo.researcher',
    'PE-001 健康效用研究（EQ-5D-5L 中国价值集）', {
      criticality: 'major', dueDate: daysFromNow(12),
    });
  completeTask(utl, 'data_collection', 'demo.data', {
    sourceData: 'CTR-2024-011 试验 EQ-5D-5L 数据（N=412，虚构）+ 文献效用值',
    instrumentRaw: 'EQ-5D-5L', sampleSize: '412', dataCustody: '数据管理部 DL-2026-03 卷宗',
  }, '数据收集完成');
  // waiting at scoring (mapping next)

  // --------------------------------------------------------- costing priced --
  const cst = makeRecord('CST', 'demo.researcher',
    'PE-001 二线 NSCLC 直接医疗成本分析', {
      criticality: 'critical', dueDate: daysFromNow(6),
      data: { currency: 'CNY，基准价格日期 2026-01-01' },
    });
  completeTask(cst, 'resource_list', 'demo.researcher', {
    resourceItems: 'PE-001 药品费；多西他赛药品费；住院（30d/周期）；门诊随访；影像与检验；≥3 级 AE 处置',
    resourceSource: 'CTR-2024-011 资源用量 + 专家咨询（12 名肿瘤科医师）',
    missingItems: '临终关怀成本待补（影响<2%，见敏感性）',
  }, '资源清单完成');
  // waiting at unit_cost

  // ------------------------------------------------- model internal validation
  const model = makeRecord('MODEL', 'demo.modeler',
    'PE-001 分区生存模型（Partitioned Survival）v2.1', {
      criticality: 'critical', dueDate: daysFromNow(15),
      data: { modelType: 'partitioned survival (分区生存)', software: 'R 4.4.1 / flexsurv', version: 'v2.1' },
    });
  completeTask(model, 'structure', 'demo.modeler', {
    structureDiagram: 'diagram/psa_v2.1.png：PFS 态 / 进展态 / 死亡',
    states: '无进展（PFS）、进展后（PD）、死亡', cycleLength: '1 个月',
    structureAssumptions: '采用标准分区生存；简化：进展后治疗路径按标准化疗；无记忆效应由分区生存结构缓解',
  }, '结构设计完成');
  signAndComplete(model, 'structure_review', 'demo.clinical', 'reviewed',
    '结构评审通过：状态划分与疾病自然史一致', {
      reviewNotes: 'PFS/PD/死亡三态合理；建议敏感性分析包括曲线外推方法选择',
      verdict: 'approved',
    }, '结构评审通过');
  completeTask(model, 'parameters', 'demo.modeler', {
    parameterTable: '参数表 v2.1：OS 外推 Weibull（试验数据）；PFS 外推；效用值引用 UTL-2026-0001；成本引用 CST-2026-0001；AE 概率来自 SLR-2026-0001',
    parameterSources: '试验(RCT) 40%；文献 35%；专家 15%；假设 10%（均标注）',
    correlations: 'PSA 中 OS/PFS 外推参数对数相关设定',
  }, '参数集完成');
  completeTask(model, 'coding', 'demo.modeler', {
    codeRef: 'R 脚本 model_psa_v2.1.R（git rev b71d03，含 lockfile）',
    outputCheck: '中位 OS 12.1 个月 vs 试验报告 12.4 个月（差异 <3%，合理）',
    debugLog: '修复贴现函数负期数问题（bug #41）',
  }, '编码完成');
  // waiting at internal_validation (ISPOR-SMDM 七问部分未答 - 演示验证欠账)

  // -------------------------------------------------------------- BIA time --
  const bia = makeRecord('BIA', 'demo.researcher',
    'PE-001 纳入医保目录的预算影响分析（5 年）', {
      criticality: 'major', dueDate: daysFromNow(11),
      data: { horizonYears: '5' },
    });
  completeTask(bia, 'population', 'demo.researcher', {
    popSources: '全国肿瘤登记中心数据（虚构口径）：年新发 NSCLC 约 106.1 万例；二线占比 32%',
    eligibleRate: '适用比例：PS 0-1 82% × 驱动基因阴性 55% × 接受二线治疗 61% ≈ 27.5%',
    popCalculation: '1,061,000 × 0.32 × 0.275 ≈ 93,000 人/年（保守 75% → 70,000 人）',
  }, '人群规模估计完成');
  // waiting at scenarios

  // --------------------------------------------------- the flagship CEA -----
  const cea = makeRecord('CEA', 'demo.researcher',
    'PE-001 二线 NSCLC 成本-效果评估报告（医保谈判用）', {
      criticality: 'critical', dueDate: daysFromNow(10),
      data: { indication: '晚期非小细胞肺癌（二线）' },
    });
  completeTask(cea, 'draft_results', 'demo.modeler', {
    outcomeMeasure: 'QALY',
    costs: 'PE-001 组：人均总成本 ¥345,000；多西他赛组：¥300,000（终身视角，5% 贴现）',
    effects: 'PE-001 组：1.72 QALY；多西他赛组：1.42 QALY',
    modelRefs: 'MODEL-2026-0002 v2.1（已发布）',
  }, '结果汇总草稿完成（引用已发布模型 v2.1）');
  signAndComplete(cea, 'incremental', 'demo.stat', 'completed',
    '增量分析完成', {
      icer: '¥150,000 /QALY（Δ成本 ¥45,000 ÷ Δ效果 0.30 QALY）',
      inmb: '¥35,100（按 3 倍人均 GDP 阈值）',
      dominance: 'trade-off (需要阈值判断)',
    }, '增量分析完成：ICER ¥150,000/QALY');
  // waiting at interpretation - 阈值解读争议点（3 倍阈值有经济性，1 倍阈值没有）

  // --------------------------------------------------- data issue (critical) --
  const diss = makeRecord('DISS', 'demo.data',
    '成本表重复计数：CST 资源清单中「住院费」与「AE 处置费」出现双重计费', {
      criticality: 'critical', dueDate: daysFromNow(3),
      data: { product: 'PE-001 成本分析' },
    });
  completeTask(diss, 'identify', 'demo.data', {
    impactOn: 'CST-2026-0001 成本分析（住院条目含 AE 处置重复计提）',
    howFound: 'QA 复核 CST-2026-0001 时发现住院费条目与 AE 处置费条目引用同一来源记录',
    immediateAction: '冻结 CST-2026-0001 的重新计算；标注受影响区间；通知研究员',
  }, '问题识别并分级为 critical');
  completeTask(diss, 'assessment', 'demo.stat', {
    biasDirection: 'overestimate (高估获益/低估成本)',
    affectedRecords: 'CST-2026-0001 全部成本结果；CEA-2026-0002 草稿中的增量成本（可能被低估 Δ成本）；MODEL-2026-0002 参数中的成本条目',
    magnitude: '重复计费约 ¥4,200/人（约占 PE-001 组总成本 1.2%）；对 ICER 影响约 +¥4,900/QALY，不翻转结论方向',
  }, '偏倚影响评估完成（方向与大小均已量化）');
  // waiting at correction - 未纠正；QA 在等

  // --------------------------------------------------- change control -------
  const chg = makeRecord('CHG', 'demo.modeler',
    '【变更】贴现率由 3% 调整为 5%（随指南更新）', {
      criticality: 'major', dueDate: daysFromNow(8),
    });
  completeTask(chg, 'request', 'demo.modeler', {
    changeType: 'parameter (参数)', rationale: '新发布的测算参考资料建议基线贴现率 5%；中国指南允许 3%-5% 区间并推荐随更新调整',
    affectedBaseline: 'PROTO-2026-0001（方案，贴现率 3%）；MODEL-2026-0002 v2.1（参数集）',
  }, '变更申请提交');
  completeTask(chg, 'impact', 'demo.researcher', {
    impactResult: '贴现率 3%→5% 使 PE-001 组终身成本下降约 4.1%、QALY 下降约 3.2%；ICER 变化约 +6.3%，结论方向不变',
    conclusionShift: 'no', docsAffected: 'CEA-2026-0002 草稿第 4.3 节、参数表、敏感性分析',
  }, '影响评估完成（方向不变，需重算）');
  // waiting at approval - 等着 HEOR 负责人批准

  // ----------------------------------------------------------- documents ----
  const docs = [
    {
      docType: 'manual', title: '成本测算与单价核实规程', titleEn: 'Costing and Unit Price Verification Procedure',
      gxpAreas: ['CST'], summary: '资源清单→单价来源分级→视角口径→贴现→复核的完整要求；单价必须附文件与价格日期。',
    },
    {
      docType: 'template', title: '成本-效用评估报告模板（医保谈判版）', titleEn: 'CUA Report Template (Reimbursement)',
      gxpAreas: ['RPT', 'ANA'], summary: '报告结构模板，内置 CHEERS 2022 字段与《中国药物经济学评价指南》报告章节骨架。',
    },
    {
      docType: 'manual', title: '模型验证规程（ISPOR-SMDM 七问）', titleEn: 'Model Validation Procedure (ISPOR-SMDM)',
      gxpAreas: ['MDL'], summary: '模型发布前的内部验证与独立外审要求；七问逐条自证格式；版本发布与会签要求。',
    },
    {
      docType: 'sop', title: '分析数据完整性管理规程', titleEn: 'Analysis Data Integrity Procedure',
      gxpAreas: ['EVS', 'OUT', 'CST', 'MDL', 'ANA', 'RPT'], summary: '原始数据保管、脚本版本控制、锁库、导出留痕、数据问题上报路径。',
    },
  ];
  for (const d of docs) {
    const doc = documents.createDocument({
      title: d.title, titleEn: d.titleEn, docType: d.docType, gxpAreas: d.gxpAreas,
      summary: d.summary, department: '药物经济学部',
      content: `${d.title}\n\n（演示文档内容）\n${d.summary}\n`,
    }, user('demo.researcher'), CONTEXT);
    created.documents += 1;
    const ver = doc.versions[0];
    if (ver) {
      const nonce = auth.issueSigningNonce(user('demo.heorlead'), null, 'signature').nonce;
      const sig = auth.sign({
        user: user('demo.heorlead'), session: null, username: 'demo.heorlead', password: PASSWORD,
        nonce, meaning: 'approved', reason: `批准《${d.title}》V1.0`,
        entityType: 'document_versions', entityId: String(ver.id),
        recordKey: `documents:${doc.id}`, stepCode: null, ctx: CONTEXT,
      });
      if (sig.ok) {
        documents.approveVersion(ver.id, { signatureId: sig.signature.id }, user('demo.heorlead'), CONTEXT);
        created.signatures += 1;
      }
    }
  }

  // ------------------------------------------------------ assessments (CHEERS)
  const template = inspections.getTemplate('CHEERS-2022');
  const assess = inspections.startAssessment({
    title: 'PE-001 成本-效果评估报告 CHEERS 2022 自查（草稿阶段）',
    templateId: template.id,
    gxpAreas: ['RPT', 'ANA', 'MDL', 'CST', 'OUT'],
    linkedRecordKey: cea.recordKey,
  }, user('demo.qa'), CONTEXT);
  created.assessments += 1;

  const gradeMap = {
    1: ['compliant', '标题含"成本-效用分析"字样'],
    2: ['compliant', '结构式摘要已按模板填写'],
    3: ['compliant', '背景含医保谈判决策语境'],
    4: ['partial', '方案未在公共平台注册，仅在内部登记 HEAP 编号 PROTO-2026-0001'],
    5: ['compliant', '二线 NSCLC 人群与适应症一致'],
    6: ['compliant', '中国医保支付方场景'],
    7: ['compliant', '对照为多西他赛（标准治疗）'],
    8: ['compliant', '终身时间范围，外推方法在附件 A'],
    9: ['compliant', '5% 贴现率，来源已注明'],
    10: ['compliant', 'QALY 为主要结局'],
    11: ['compliant', '试验 EQ-5D-5L 数据'],
    12: ['partial', '中国 EQ-5D-5L 价值集已注明，但映射步骤验证指标（R²）未写入报告'],
    13: ['gap', '成本表第 3.4 节"住院费"与"AE 处置费"存在重复计数（见 DISS-2026-0001），尚未纠正'],
    14: ['compliant', '人民币、基准价格日期 2026-01-01 已注明'],
    15: ['compliant', '模型结构图已引用 MODEL-2026-0002 验证文档'],
    16: ['compliant', '关键假设清单见 4.7 节'],
    18: ['not_applicable', '未做分布效应分析（药品不涉及特殊人群差异）'],
    19: ['gap', 'PSA 已完成但可接受曲线图未生成；参数分布表缺 2 个参数'],
    21: ['compliant', '参数表完整引用'],
    22: ['compliant', '增量分析表含 ΔC/ΔE/ICER'],
    23: ['gap', '不确定性章节为空：DSA 龙卷风图与 PSA 结果未写入'],
    26: ['compliant', '资助方为康济医药（虚构），角色为资助研究'],
    27: ['compliant', '作者利益冲突声明已附'],
  };
  for (const finding of assess.findings) {
    const spec = gradeMap[finding.item ? finding.item.seq : 0];
    if (!spec) continue; // 未在映射中的条目保持 not_assessed（不计入分母）
    const [grade, evidence] = spec;
    if (grade === 'not_applicable') {
      inspections.assessItem(finding.id, { grade: 'not_applicable', evidence: '', observation: evidence }, user('demo.qa'), CONTEXT);
      continue;
    }
    const evidenceText = grade === 'compliant' ? (evidence + '；证据：报告对应章节已核' ) : evidence;
    const observation = grade === 'compliant' ? null : `缺陷说明：${evidence}`;
    inspections.assessItem(finding.id, { grade, evidence: evidenceText, observation }, user('demo.qa'), CONTEXT);
    created.findings += 1;
  }

  // Link the critical findings (item 13 / 23) to the DISS record (in treatment).
  for (const finding of assess.findings) {
    if (finding.item && [13, 23].includes(finding.item.seq)) {
      inspections.linkFindingToRecord(finding.id, diss.id, user('demo.qa'), CONTEXT);
    }
  }

  // ------------------------------------------------- model validation checks --
  const modelTemplate = inspections.getTemplate('ISPOR-SMDM-MODEL');
  const modelAssess = inspections.startAssessment({
    title: 'MODEL-2026-0002 v2.1 发布前验证自查（ISPOR-SMDM 七问）',
    templateId: modelTemplate.id,
    gxpAreas: ['MDL', 'ANA'],
    linkedRecordKey: model.recordKey,
  }, user('demo.qa'), CONTEXT);
  created.assessments += 1;
  const modelGrades = {
    1: ['compliant', '结构文档 model_readme_v2.1.pdf 已随代码归档', null],
    2: ['compliant', '输入输出清单已生成（inputs/CSV 全量导出）', null],
    3: ['compliant', '假设清单 4.7 节，结构与临床评审一致', null],
    4: ['compliant', '单元测试 32/32 通过；退化检验记录在案', null],
    5: ['compliant', '中位 OS 12.1 个月 vs 试验 12.4 个月，差异已解释', null],
    6: ['compliant', '与 PICO 映射表完成', null],
    7: ['gap', '独立复现已归档但依赖的 R 包版本清单（renv.lock）未附', '评审复现时缺 lockfile'],
    8: ['compliant', 'core 计算测试通过', null],
    9: ['partial', '概率参数用 Beta 设定正确；2 个成本参数用 Normal（可能取负）', '成本参数分布待改为 Gamma'],
    10: ['compliant', '周期长度与曲线外推情景已完成', null],
    11: ['compliant', '代码审查记录 2026-03-02（审查人：demo.stat）', null],
    12: ['gap', 'v2.0 与 v2.1 的差异清单未附变更追溯', '变更清单待补'],
  };
  for (const finding of modelAssess.findings) {
    const spec = modelGrades[finding.item ? finding.item.seq : 0];
    if (!spec) continue; // 未映射条目保持 not_assessed
    const [grade, evidence, observation] = spec;
    inspections.assessItem(finding.id, {
      grade: grade === 'not_applicable' ? 'not_applicable' : grade,
      evidence: grade === 'compliant' ? evidence + '；已核对应证据' : evidence,
      observation: observation || null,
    }, user('demo.qa'), CONTEXT);
    created.findings += 1;
  }

  // ------------------------------------------------ audited calculations -----
  analysis.calculateCEA({
    label: 'PE-001 基础分析（终身视角，5% 贴现）',
    costNew: 345000, costComp: 300000, effectNew: 1.72, effectComp: 1.42,
    wtp: 293000, outcomeName: 'QALY', _ctx: CONTEXT,
  }, user('demo.researcher'));
  created.calculations += 1;
  analysis.calculateCEA({
    label: 'PE-001 降价 15% 情景', costNew: 293250, costComp: 300000,
    effectNew: 1.72, effectComp: 1.42, wtp: 293000, outcomeName: 'QALY', _ctx: CONTEXT,
  }, user('demo.researcher'));
  created.calculations += 1;
  analysis.calculateBIA({
    label: 'PE-001 医保准入预算影响（5 年，通胀 0）',
    population: 93000, shareNew: [0.08, 0.12, 0.16, 0.19, 0.21],
    costNewPerPatient: 180000, costCompPerPatient: 96000,
    horizonYears: 5, _ctx: CONTEXT,
  }, user('demo.researcher'));
  created.calculations += 1;
  analysis.calculateQALY({
    label: 'PE-001 组 QALY 累计（5% 贴现）',
    discountRate: 0.05,
    cycles: [
      { utility: 0.71, years: 1.1 },
      { utility: 0.62, years: 1.4 },
      { utility: 0.45, years: 1.9 },
    ],
    _ctx: CONTEXT,
  }, user('demo.researcher'));
  created.calculations += 1;

  // ------------------------------------------------------------- done ---------
  const chain = audit.verifyChain();
  process.stdout.write('\n  Summary:\n');
  process.stdout.write(`    Users        ${created.users} personas ensured\n`);
  process.stdout.write(`    Records      ${created.records} workflow records\n`);
  process.stdout.write(`    Steps done   ${created.steps}\n`);
  process.stdout.write(`    Signatures   ${created.signatures}\n`);
  process.stdout.write(`    Documents    ${created.documents}\n`);
  process.stdout.write(`    Assessments  ${created.assessments} (${created.findings} findings graded)\n`);
  process.stdout.write(`    Calculations ${created.calculations}\n`);
  process.stdout.write(`    Audit trail  ${chain.checked} entries, integrity ${chain.ok ? 'OK' : 'FAILED'}\n`);
  process.stdout.write('\n  REMINDER: this instance now contains FICTIONAL records. Do not use it\n');
  process.stdout.write('  for real work. Delete data\\pe.db to start clean.\n\n');

  db.close();
  process.exit(chain.ok ? 0 : 2);
}

if (require.main === module) main();