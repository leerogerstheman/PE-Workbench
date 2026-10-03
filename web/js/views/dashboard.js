/* PE-Workbench · 仪表盘视图：就绪度 + 具名阻碍项 + 记录概览 + 我的待办。 */

window.Views.register('dashboard', {
  routes: [{ pattern: '/dashboard' }],
  async render() {
    const data = await API.get('/api/dashboard');
    const d = data.dashboard;
    const ui = UI;
    const frag = document.createDocumentFragment();

    frag.appendChild(ui.h(`<h1>仪表盘 <span class="muted small">/ 整个分析项目组的就绪状态</span></h1>`));

    // -------------------------------------------------------- readiness -----
    const rd = d.readiness || {};
    const kpis = ui.h(`
      <div class="kpi-row">
        <div class="kpi ${(rd.score || 0) >= 80 ? 'ok' : 'danger'}" data-href="#/assessments"><div class="num">${rd.score == null ? '—' : rd.score}</div><div class="lbl">就绪度评分（0-100）→ 查看评估</div></div>
        <div class="kpi" data-href="#/records?open=1"><div class="num">${d.records.open}</div><div class="lbl">进行中记录 → 打开</div></div>
        <div class="kpi danger" data-href="#/records?open=1"><div class="num">${d.records.overdue}</div><div class="lbl">已超期记录 → 打开</div></div>
        <div class="kpi" data-href="#/assessments"><div class="num">${d.assessments.total}</div><div class="lbl">检查表评估（含进行中）→ 打开</div></div>
        <div class="kpi ${d.chainOk ? 'ok' : 'danger'}" data-href="#/audit"><div class="num">${d.chainOk ? '✓' : '✗'}</div><div class="lbl">审计链完整性（${d.chainChecked} 条）→ 审计</div></div>
      </div>
    `);
    kpis.querySelectorAll('[data-href]').forEach((n) => {
      n.style.cursor = 'pointer';
      n.addEventListener('click', () => { location.hash = n.dataset.href; });
    });
    frag.appendChild(kpis);

    const blockers = (rd.blockers || []).map((b) =>
      ui.h(`<div class="item-row"><div class="ic">${b.points >= 10 ? '🔴' : '🟡'}</div><div class="body"><div class="tt">${UI.escapeHtml(b.label)}</div><div class="meta">扣分 −${b.points}</div></div></div>`)
    );
    const blockersCard = ui.el('div', { class: 'card' });
    blockersCard.appendChild(ui.h(`<h3>具名阻碍项 <span class="muted small">/ 每一项都可以找到具体记录，不是分数游戏</span></h3>`));
    if (blockers.length) blockers.forEach((b) => blockersCard.appendChild(b));
    else blockersCard.appendChild(ui.h(`<div class="empty">当前没有阻塞提交的阻碍项。</div>`));
    frag.appendChild(blockersCard);

    // ------------------------------------------------------------ alerts ----
    const alerts = (d.alerts || []).map((a) =>
      ui.h(`<div class="item-row"><div class="ic">${a.level === 'critical' ? '🔴' : '🟠'}</div><div class="body"><div class="tt">${UI.escapeHtml(a.title)}</div><div class="meta">${UI.escapeHtml(a.body)}</div></div><a class="btn small" href="${a.link || '#/dashboard'}">查看</a></div>`)
    );
    const alertsCard = ui.el('div', { class: 'card' });
    alertsCard.appendChild(ui.h(`<h3>警报 <span class="muted small">/ 按后果排序，直呼其名</span></h3>`));
    if (alerts.length) alerts.forEach((a) => alertsCard.appendChild(a));
    else alertsCard.appendChild(ui.h(`<div class="empty">没有警报。监视进程每 5 分钟扫描一次超期与升级。</div>`));
    frag.appendChild(alertsCard);

    // ---------------------------------------------------------- records -----
    const byProcess = (d.records.byProcess || []).map((r) => {
      let pname = r.process_code;
      try { pname = r.process_code; } catch { /* keep */ }
      return ui.h(`
        <tr class="clickable" data-href="#/records?processCode=${encodeURIComponent(pname)}">
          <td class="mono">${UI.escapeHtml(pname)}</td><td>${r.n}</td><td>${r.open || 0}</td>
          <td><span class="${(r.overdue || 0) ? 'sev-critical' : 'muted'}">${r.overdue || 0}</span></td>
        </tr>`);
    });
    const recCard = ui.el('div', { class: 'card' });
    recCard.appendChild(ui.h(`<h3>各流程记录 <span class="muted small">/ 点击行查看</span></h3>`));
    const tbl = ui.h(`
      <div class="table-wrap"><table class="pe">
        <thead><tr><th>流程</th><th>总数</th><th>进行中</th><th>超期</th></tr></thead>
        <tbody></tbody></table></div>`);
    const tbody = tbl.querySelector('tbody');
    byProcess.forEach((r) => tbody.appendChild(r));
    recCard.appendChild(tbl);
    frag.appendChild(recCard);

    // ----------------------------------------------------------- my work ----
    const my = d.myWork || {};
    const myCard = ui.el('div', { class: 'card' });
    myCard.appendChild(ui.h(`<h3>我的待办 <span class="muted small">/ ${my.pending || 0} 项，其中 ${my.requiresSignature || 0} 项需电子签名，${my.overdue || 0} 项已超期</span></h3>`));
    const me = App.currentUser();
    if (me) {
      const go = ui.el('a', { class: 'btn primary', href: '#/inbox', text: `打开我的待办（${my.pending || 0}）` });
      myCard.appendChild(go);
      myCard.appendChild(ui.h(`
        <div class="small muted" style="margin-top:10px">当前岗位：${UI.escapeHtml(me.roleLabel || me.role)}。待办按后果轻重排序：严重(critical)优先、需签名优先、超期优先。</div>
      `));
    }
    frag.appendChild(myCard);

    // -------------------------------------------------------- coverage ------
    const cov = (d.coverage || []).map((c) =>
      ui.h(`<tr><td><span class="pill color" style="background:${UI.escapeHtml(c.colour)}">${UI.escapeHtml(c.code)}</span> ${UI.escapeHtml(c.name)}</td><td>${c.processes}</td><td>${c.templates}</td><td>${c.records}</td></tr>`)
    );
    const covCard = ui.el('div', { class: 'card' });
    covCard.appendChild(ui.h(`<h3>领域覆盖 <span class="muted small">/ 每个专业领域有多少工作流、检查表与记录</span></h3>`));
    const covTbl = ui.h(`<div class="table-wrap"><table class="pe"><thead><tr><th>领域</th><th>工作流</th><th>检查表</th><th>记录</th></tr></thead><tbody></tbody></table></div>`);
    cov.forEach((r) => covTbl.querySelector('tbody').appendChild(r));
    covCard.appendChild(covTbl);
    frag.appendChild(covCard);

    frag.querySelectorAll('[data-href]').forEach((node) => {
      node.addEventListener('click', () => { location.hash = node.dataset.href; });
    });

    return frag;
  },
});