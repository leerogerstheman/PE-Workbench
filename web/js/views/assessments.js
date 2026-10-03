/* PE-Workbench · 自查与检查表：模板库 + 评估运行 + 逐条判定。
 *
 * 三条路由：
 *   #/assessments        评估列表 + 检查表模板库
 *   #/assessments/:code  一次评估的逐条判定（负面判定强制客观证据）
 *   #/checklists/:code   检查表模板详情
 */

window.Views.register('assessments', {
  routes: [
    { pattern: '/assessments' },
    { pattern: '/assessments/:code' },
    { pattern: '/checklists/:code' },
  ],
  async render(params, ctx) {
    const ui = UI;
    const esc = UI.escapeHtml;
    const frag = document.createDocumentFragment();

    if (params.code && ctx.hash.startsWith('#/checklists/')) return await renderTemplate(params.code);
    if (params.code) return await renderAssessment(params.code);

    const [assessments, templates] = await Promise.all([
      API.get('/api/assessments'),
      API.get('/api/templates'),
    ]);

    frag.appendChild(ui.h(`<h1>自查与检查表 <span class="muted small">/ 报告与模型的"照妖镜"</span></h1>`));
    frag.appendChild(ui.h(`
      <div class="philosophy-quote">理念：<strong>负面判定必须带客观证据。</strong>把"部分符合/存在缺陷"写出来而不给出至少 10 个字的证据，
      在核查中不可辩护——所以系统直接在入口拦住。检查表的每一项都来自公开报告规范（CHEERS 2022、中国指南 2020、ISPOR-SMDM、ALCOA+）。</div>
    `));

    // ------------------------------------------------------------- templates --
    const tCard = ui.el('div', { class: 'card' });
    tCard.appendChild(ui.h(`<h3>检查表模板库</h3>`));
    const tGrid = ui.el('div', { class: 'grid c3', id: 'tpl-grid' });
    for (const t of templates.templates) {
      const card = ui.el('div', { class: 'card', style: 'cursor:pointer;margin:0' });
      card.innerHTML = `
        <h3>${esc(t.title)}</h3>
        <div class="card-sub">${esc(t.code)} · ${t.itemCount} 项要求 · ${esc(t.scope || '')}</div>
        <div class="btn-row">
          <span class="pill">critical ${t.riskCounts.critical}</span>
          <span class="pill">major ${t.riskCounts.major}</span>
          <span class="pill">minor ${t.riskCounts.minor}</span>
        </div>
        <div class="small muted" style="margin-top:8px">${esc(t.description || '')}</div>
      `;
      card.addEventListener('click', () => { location.hash = '#/checklists/' + t.code; });
      tGrid.appendChild(card);
    }
    tCard.appendChild(tGrid);
    frag.appendChild(tCard);

    // ---------------------------------------------------------- assessments --
    frag.appendChild(ui.h(`<h2>评估记录 <span class="muted small">/ 启动一次评估，对照检查表逐条判定</span></h2>`));
    if (App.hasPerm('inspection.manage')) {
      const btn = ui.el('button', { class: 'btn primary', text: '+ 启动评估', onclick: () => openStart(templates.templates) });
      frag.appendChild(ui.el('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [btn]));
    }
    const aCard = ui.el('div', { class: 'card' });
    const tbl = ui.el('div', { class: 'table-wrap' });
    tbl.appendChild(ui.h(`
      <table class="pe"><thead><tr><th>编号</th><th>标题</th><th>检查表</th><th>就绪度</th><th>严重缺陷</th><th>状态</th></tr></thead><tbody></tbody></table>
    `));
    const tbody = tbl.querySelector('tbody');
    for (const a of assessments.assessments) {
      const tpl = templates.templates.find((t) => t.id === a.templateId);
      const gaps = (a.counts && a.counts.gap) || 0;
      tbody.appendChild(ui.h(`
        <tr class="clickable" data-href="#/assessments/${esc(a.code)}">
          <td class="mono">${esc(a.code)}</td><td>${esc(a.title)}</td>
          <td>${esc(tpl ? tpl.code : '')}</td>
          <td><strong>${a.readinessScore != null ? a.readinessScore : '—'}</strong></td>
          <td><span class="${gaps ? 'sev-critical' : 'muted'}">${gaps}</span></td>
          <td><span class="badge ${a.status === 'closed' ? 'green' : 'blue'}">${esc(a.status)}</span></td>
        </tr>`));
    }
    if (!assessments.assessments.length) tbody.appendChild(ui.h(`<tr><td colspan="6"><div class="empty">还没有评估记录。</div></td></tr>`));
    aCard.appendChild(tbl);
    frag.appendChild(aCard);
    frag.querySelectorAll('[data-href]').forEach((n) => n.addEventListener('click', () => { location.hash = n.dataset.href; }));

    return frag;

    // ------------------------------------------------------------ perform ---
    async function renderTemplate(code) {
      const data = await API.get('/api/templates/' + code);
      const t = data.template;
      frag.appendChild(ui.h(`<h1>${esc(t.code)} · ${esc(t.title)}</h1>`));
      frag.appendChild(ui.h(`<div class="alert info">${esc(t.description || '')}<br><span class="small muted">依据：${esc(t.regulation || '')} · 发布方：${esc(t.authority || '')}</span></div>`));
      if (App.hasPerm('inspection.manage')) {
        const btn = ui.el('button', { class: 'btn primary', text: '用此检查表启动评估', onclick: () => openStart([t], t.id) });
        frag.appendChild(ui.el('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [btn]));
      }
      const items = ui.el('div', { id: 'tpl-items' });
      for (const it of t.items) {
        items.appendChild(ui.h(`
          <div class="checklist-item">
            <div class="ref mono">${esc(it.seq)}. ${esc(it.clauseRef || '')} <span class="badge ${it.riskLevel === 'critical' ? 'red' : it.riskLevel === 'major' ? 'amber' : 'gray'}">${esc(it.riskLevel)}</span></div>
            <div class="req">${esc(it.requirement)}</div>
            ${it.guidance ? `<div class="gd">${esc(it.guidance)}</div>` : ''}
            ${it.evidenceHint ? `<div class="small muted">建议证据：${esc(it.evidenceHint)}</div>` : ''}
          </div>`));
      }
      frag.appendChild(items);
      return frag;
    }

    async function renderAssessment(code) {
      const data = await API.get('/api/assessments/' + code);
      const a = data.assessment;
      frag.appendChild(ui.h(`
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
          <h1><span class="mono">${esc(a.code)}</span> · ${esc(a.title)}</h1>
          <a class="btn small" href="#/assessments">← 全部评估</a>
        </div>
      `));
      frag.appendChild(ui.h(`
        <div class="kpi-row">
          <div class="kpi ${(a.readinessScore || 0) >= 80 ? 'ok' : 'danger'}"><div class="num">${a.readinessScore == null ? '—' : a.readinessScore}</div><div class="lbl">就绪度</div></div>
          <div class="kpi"><div class="num">${a.counts.compliant || 0}</div><div class="lbl">符合</div></div>
          <div class="kpi"><div class="num">${a.counts.partial || 0}</div><div class="lbl">部分符合</div></div>
          <div class="kpi danger"><div class="num">${a.counts.gap || 0}</div><div class="lbl">存在缺陷</div></div>
          <div class="kpi"><div class="num">${a.counts.open || 0}</div><div class="lbl">未关闭项</div></div>
        </div>
      `));
      const list = ui.el('div', { id: 'findings' });
      for (const f of a.findings) {
        const neg = f.assessedGrade === 'gap' || f.assessedGrade === 'partial';
        const item = ui.el('div', { class: 'checklist-item' + (neg ? ' neg' : '') });
        item.innerHTML = `
          <div class="ref mono">${esc(f.clauseRef || '')} <span class="badge ${f.riskLevel === 'critical' ? 'red' : f.riskLevel === 'major' ? 'amber' : 'gray'}">${esc(f.riskLevel)}</span></div>
          <div class="req">${esc(f.requirement)}</div>
          ${f.item && f.item.guidance ? `<div class="gd">${esc(f.item.guidance)}</div>` : ''}
          <div class="small muted" style="margin-top:6px">判定：<strong>${esc(I18N.gradeLabel(f.assessedGrade))}</strong>
            ${f.assessedBy ? ` · 评估人 ${esc(f.assessedBy)}` : ''}${f.assessedAt ? ` · ${ui.fmtDate(f.assessedAt)}` : ''}
            ${f.status ? ` · 状态 ${esc(f.status)}` : ''}
          </div>
          ${f.objectiveEvidence ? `<div class="small" style="margin-top:4px"><strong>客观证据：</strong>${esc(f.objectiveEvidence)}</div>` : ''}
          ${f.observation ? `<div class="small" style="margin-top:2px"><strong>说明：</strong>${esc(f.observation)}</div>` : ''}
          ${f.workflowId ? `<div class="small" style="margin-top:2px"><strong>关联记录：</strong>已转记录处理（ID ${esc(f.workflowId)}）</div>` : ''}
        `;
        if (App.hasPerm('inspection.manage') && a.status !== 'closed') {
          const row = ui.el('div', { class: 'btn-row' });
          const gradeBtn = ui.el('button', { class: 'btn small', text: '判定', onclick: () => openGrade(f) });
          const linkBtn = ui.el('button', { class: 'btn small', text: '转记录', onclick: () => openLink(f) });
          const closeBtn = ui.el('button', { class: 'btn small danger', text: '关闭缺陷', onclick: () => openClose(f) });
          row.appendChild(gradeBtn);
          if (neg && !f.workflowId) row.appendChild(linkBtn);
          if (neg && f.status !== 'closed') row.appendChild(closeBtn);
          item.appendChild(row);
        }
        list.appendChild(item);
      }
      frag.appendChild(list);
      return frag;

      function openGrade(f) {
        const m = ui.modal({ title: `判定：${esc(f.clauseRef || '')}` });
        const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
        form.appendChild(ui.h(`<label>判定结果</label>`));
        const sel = ui.el('select');
        for (const g of ['compliant', 'partial', 'gap', 'not_applicable']) {
          const o = document.createElement('option');
          o.value = g; o.textContent = I18N.gradeLabel(g);
          o.selected = g === f.assessedGrade;
          sel.appendChild(o);
        }
        form.appendChild(sel);
        form.appendChild(ui.h(`<label>客观证据（部分符合/存在缺陷时必填，≥10 字）</label>`));
        form.appendChild(ui.el('textarea', { name: 'evidence', value: f.objectiveEvidence || '' }));
        form.appendChild(ui.h(`<label>说明（可选）</label>`));
        form.appendChild(ui.el('textarea', { name: 'observation', value: f.observation || '' }));
        const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
        form.appendChild(errBox);
        form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">保存判定</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
        m.content.appendChild(form);

        async function submit() {
          const fd = new FormData(form);
          try {
            await API.post(`/api/assessments/${a.code}/findings/${f.id}/assess`, {
              grade: fd.get('grade'), evidence: fd.get('evidence'), observation: fd.get('observation'),
            });
            m.close();
            UI.toast('判定已保存', 'ok');
            App.route();
          } catch (err) {
            errBox.style.display = '';
            errBox.textContent = err.message;
          }
        }
      }

      function openLink(f) {
        const m = ui.modal({ title: '将缺陷转为处理记录' });
        m.content.appendChild(ui.h(`<div class="alert warn">把缺陷交给一条 DISS（数据问题）或 CHG（变更控制）记录去闭环。输入记录 ID 或查列表。</div>`));
        m.content.appendChild(ui.h(`<label>记录 ID</label>`));
        const inp = ui.el('input', { type: 'number', placeholder: '如 42' });
        m.content.appendChild(inp);
        const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
        m.content.appendChild(errBox);
        m.content.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" id="link-ok">链接</button><button class="btn" onclick="UI.closeModal()">取消</button></div>`));
        m.content.querySelector('#link-ok').addEventListener('click', async () => {
          try {
            await API.post(`/api/assessments/${a.code}/findings/${f.id}/link`, { workflowId: Number(inp.value) });
            m.close();
            UI.toast('已链接', 'ok');
            App.route();
          } catch (err) {
            errBox.style.display = '';
            errBox.textContent = err.message;
          }
        });
      }

      function openClose(f) {
        const m = ui.modal({ title: '关闭缺陷' });
        const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
        form.appendChild(ui.h(`<label>关闭响应（≥10 字，说明纠正与验证）</label>`));
        form.appendChild(ui.el('textarea', { name: 'response' }));
        const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
        form.appendChild(errBox);
        form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">确认关闭</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
        m.content.appendChild(form);
        async function submit() {
          const fd = new FormData(form);
          try {
            await API.post(`/api/assessments/${a.code}/findings/${f.id}/close`, { response: fd.get('response') });
            m.close();
            UI.toast('缺陷已关闭', 'ok');
            App.route();
          } catch (err) {
            errBox.style.display = '';
            errBox.textContent = err.message;
          }
        }
      }
    }

    function openStart(templates, presetId) {
      const m = ui.modal({ title: '启动评估' });
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
      form.appendChild(ui.h(`<label>评估标题</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'title', placeholder: '如：CEA 报告 CHEERS 自查' }));
      form.appendChild(ui.h(`<label>检查表</label>`));
      const sel = ui.el('select', { name: 'templateId' });
      for (const t of templates) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = `${t.code} · ${t.title}`;
        o.selected = presetId === t.id;
        sel.appendChild(o);
      }
      form.appendChild(sel);
      form.appendChild(ui.h(`<label>关联记录号（可选，如 CEA-2026-0002）</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'linkedRecordKey' }));
      form.appendChild(ui.h(`<label>完成期限（可选）</label>`));
      form.appendChild(ui.el('input', { type: 'date', name: 'dueDate' }));
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">启动</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
      m.content.appendChild(form);

      async function submit() {
        const fd = new FormData(form);
        try {
          const res = await API.post('/api/assessments', {
            title: fd.get('title'), templateId: Number(fd.get('templateId')),
            linkedRecordKey: fd.get('linkedRecordKey') || undefined,
            dueDate: fd.get('dueDate') || undefined,
          });
          m.close();
          UI.toast('评估已启动', 'ok');
          location.hash = '#/assessments/' + res.assessment.code;
        } catch (err) {
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
    }
  },
});