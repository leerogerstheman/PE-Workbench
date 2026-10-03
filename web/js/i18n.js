/* PE-Workbench · 药物经济学工作台 - 国际化与文案。
 *
 * 中文为主、英文并行：分析术语在两个方向上都会被使用——国内研究员读中文
 * 规程，但申报与期刊要求英文术语（ICER、QALY、CHEERS…）。合规术语以
 * "中文 / English" 形式并排展示，而不是翻译掉。
 */

window.I18N = (function () {
  const DICT = {
    appName: '药物经济学工作台',
    appNameEn: 'PE-Workbench',
    nav: {
      dashboard: '仪表盘',
      inbox: '我的待办',
      domains: '领域与流程',
      records: '质量记录',
      analysis: '分析工具',
      assessments: '自查与检查表',
      documents: '文件控制',
      audit: '审计追踪',
      users: '用户与权限',
      philosophy: '设计理念',
      signout: '退出登录',
    },
    common: {
      save: '保存', cancel: '取消', close: '关闭', confirm: '确认', create: '创建', edit: '编辑',
      submit: '提交', approve: '批准', review: '审阅', verify: '核实', sign: '签署', back: '返回',
      search: '搜索', filter: '筛选', all: '全部', reason: '理由（必填）', notes: '说明',
      dueDate: '期限', status: '状态', none: '无', loading: '加载中…', required: '必填',
      viewDetail: '查看详情',
    },
    status: {
      draft: '草稿', in_review: '评审中', approved: '已批准', in_amendment: '修订中',
      search_approved: '检索已批准', screening: '筛选中', extraction: '提取中',
      assessment: '质量评估中', synthesis: '证据综合中', qa_review: 'QA 审阅中',
      data_collected: '数据已收集', scoring: '评分中', mapping: '映射验证中',
      clinical_verified: '临床已审', resources: '资源清单中', priced: '单价核实中',
      calculated: '已核算', reviewed: '已复核', structure_reviewed: '结构已评审',
      parameterized: '参数已定', coded: '已编码', internally_validated: '内部验证中',
      externally_reviewed: '外审中', published: '已发布', population: '人群估计中',
      scenarios: '情景设定中', analysis_done: '分析完成', interpreted: '已解读',
      cheers_checked: '已核查', submitted: '已提交', identified: '已识别',
      under_assessment: '影响评估中', corrected: '已纠正', implemented: '已实施',
      verified: '已验证', closed: '已关闭', cancelled: '已取消', rejected: '已拒绝',
      in_progress: '进行中', overdue: '已超期',
    },
    grade: {
      compliant: '符合', partial: '部分符合', gap: '存在缺陷', not_applicable: '不适用', not_assessed: '未评估',
    },
    risk: {
      critical: '严重', major: '重要', minor: '次要',
    },
  };

  function t(key) {
    if (!key) return '';
    const parts = key.split('.');
    let node = DICT;
    for (const p of parts) {
      if (!node[p]) return key;
      node = node[p];
    }
    return typeof node === 'string' ? node : key;
  }

  function statusLabel(status) {
    return t('status.' + status) || status;
  }

  function gradeLabel(grade) {
    return t('grade.' + grade) || grade;
  }

  function riskLabel(level) {
    const map = { critical: '严重 critical', major: '重要 major', minor: '次要 minor' };
    return map[level] || level;
  }

  return { t, statusLabel, gradeLabel, riskLabel };
})();