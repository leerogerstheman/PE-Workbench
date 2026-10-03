/* PE-Workbench · 设计理念页：为什么这个工作台长这样。
 *
 * 把系统背后"可辩护的分析工作"理念直白地摆出来——每条理念都指向
 * 系统里真实存在的机制，不是口号。
 */

window.Views.register('philosophy', {
  routes: [{ pattern: '/philosophy' }],
  async render() {
    const ui = UI;
    const frag = document.createDocumentFragment();
    const phiData = await API.get('/api/philosophy');

    frag.appendChild(ui.h(`<h1>设计理念 <span class="muted small">/ 为什么这样工作</span></h1>`));
    frag.appendChild(ui.h(`
      <div class="philosophy-quote">一句话：<strong>药物经济学结论的价值取决于它能否被审查。</strong>
      一个报告提交之前，系统已经替你回答了四个问题——数字从哪来？谁批准过？改过没有？能不能复现？</div>
    `));

    const principles = [
      ['领域是数据，不是代码', '七个专业领域共用同一套受控流程引擎。加一条新流程 = 往 seed/workflows/ 放一个 JSON 文件，不写代码。工作流的形态（步骤、角色、签名、必填字段）全部可配置、可审查。'],
      ['流程细节直接写在图上', '流程图每步下面直接列出负责岗位、签名门槛与指引——不放在悬浮提示里。因为流程图是要截图、打印、贴到评审会墙上的东西。'],
      ['三态权限矩阵，不撒谎', '界面只说服务端真正会做的事。允许 / 不允许之外还有第三种状态"⚠ 有约束"：例如 HEOR 负责人持有 record.close，但内核仍拒绝他关闭自己起草的记录。'],
      ['控制做进机制，不靠自觉', '哈希链审计（只可追加）、双要素电子签名（密码+动态口令/挑战码）、修改必须填理由、负面判定必须带客观证据——都是代码强制的，不是制度要求。'],
      ['职责分离是硬约束', '提出数据问题的人不能自己关闭；建模型的人不能自己发布；报告起草人不能自己批准。ICH Q10 / Annex 11 §12.1 的精神，对分析数据同样成立。'],
      ['不确定性不是缺陷，不展示才是', 'ICER 必须与增量成本、增量效果、阈值来源、敏感性结果一起出现（CHEERS 2022 第 22-23 项）。计算工具每次运算都留痕，报告里每个数字都可回溯。'],
      ['就绪度常态可见', '不是年底突击自查：critical 缺陷、超期记录、文件审核欠账、模型验证缺口——全部汇成一个带具名阻碍项的评分，随时可看。'],
      ['工作流自己跑', '后台监视进程每 5 分钟扫描超期与升级，生成待办并推给责任角色——不需要有人打开页面才能发现事情在烂掉。'],
      ['可见性按职能关系，不按级别', 'QA 能跨领域看全部岗位（这是它的职能），研究员只见自己领域，系统管理员反而看不到别人的人员信息——技术权限不等于阅读他人分析工作的许可。'],
      ['外部评审限时访问', '外部评审专家只读、限时，登录时与每个请求都校验有效期；到期自动失效。每一次查看都被审计。'],
      ['检查表来自公开规范', 'CHEERS 2022（28 项）、中国药物经济学评价指南（2020）、ISPOR-SMDM 模型透明度七问、ALCOA+——条目为系统自拟的自查断言，使用时请与原文清单核对（见 docs/）。'],
    ];

    const grid = ui.el('div', { class: 'philosophy-block' });
    for (const [title, body] of principles) {
      const card = ui.el('div', { class: 'card' });
      card.appendChild(ui.h(`<h3>${UI.escapeHtml(title)}</h3>`));
      card.appendChild(ui.h(`<div class="small">${UI.escapeHtml(body)}</div>`));
      grid.appendChild(card);
    }
    frag.appendChild(grid);

    // --------------------------------------------------- domain philosophies --
    frag.appendChild(ui.h(`<h2 style="margin-top:22px">领域理念 <span class="muted small">/ 七个专业领域各自的工作哲学</span></h2>`));
    const dGrid = ui.el('div', { class: 'philosophy-block' });
    for (const [code, phi] of Object.entries(phiData.philosophy || {})) {
      const card = ui.el('div', { class: 'card' });
      card.appendChild(ui.h(`<h3><span class="pill color" style="background:#0e7490">${UI.escapeHtml(code)}</span></h3>`));
      card.appendChild(ui.h(`<div class="small">${UI.escapeHtml(phi)}</div>`));
      dGrid.appendChild(card);
    }
    frag.appendChild(dGrid);

    frag.appendChild(ui.h(`
      <div class="alert info" style="margin-top:20px"><strong>免责</strong>：本工作台是辅助工具，不替代专业判断、不构成卫生技术评估结论。
      检查表条目为系统依据公开规范拟定的自查断言，正式申报前请与各规范原文及主管部门要求逐项核对。</div>
    `));
    return frag;
  },
});