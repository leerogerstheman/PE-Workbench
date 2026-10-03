/* PE-Workbench · 质量记录列表：按流程筛选、创建新记录。 */

window.Views.register('records', {
  routes: [{ pattern: '/records' }],
  async render(params, ctx) {
    const ui = UI;
    const frag = document.createDocumentFragment();
    const esc = UI.escapeHtml;
    const query = new URLSearchParams((ctx.hash.split('?')[1]) || '');

    const workflowData = await API.get('/api/workflows');
    const processCode = query.get('processCode') || '';
    const status = query.get('status') || '';
    const open = query.get('open') || '';

    let qs = new URLSearchParams();
    if (processCode) qs.set('processCode', processCode);
    if (status) qs.set('status', status);
    if (open === '1') qs.set('open', '1');
    const data = await API.get('/api/records?' + qs.toString());

    frag.appendChild(ui.h(`<h1>质量记录 <span class="muted small">/ 受控的受控：每一条记录都是'一串有角色门槛、部分需签名的步骤'</span></h1>`));

    // ------------------------------------------------------------- filters --
    const filterCard = ui.el('div', { class: 'card' });
    const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); applyFilters(); } });
    const row = ui.el('div', { class: 'form-row' });
    row.appendChild(ui.h(`<div><label>流程</label><select name="processCode"><option value="">全部流程</option>${workflowData.workflows.map((w) => `<option value="${esc(w.code)}" ${w.code === processCode ? 'selected' : ''}>${esc(w.code)} · ${esc(w.name)}</option>`).join('')}</select></div>`));
    row.appendChild(ui.h(`<div><label>状态</label><select name="status"><option value="">全部状态</option>${['draft', 'in_progress', 'approved', 'in_review', 'published', 'closed', 'cancelled'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${esc(I18N.statusLabel(s))}</option>`).join('')}</select></div>`));
    row.appendChild(ui.h(`<div><label>范围</label><select name="open"><option value="">全部</option><option value="1" ${open === '1' ? 'selected' : ''}>仅进行中</option></select></div>`));
    form.appendChild(row);
    form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">筛选</button><button class="btn" type="button" onclick="location.hash='#/records'">重置</button></div>`));
    filterCard.appendChild(form);
    frag.appendChild(filterCard);

    // -------------------------------------------------------------- create ---
    if (App.hasPerm('record.create')) {
      const createBtn = ui.el('button', { class: 'btn primary', text: '+ 新建记录', onclick: () => openCreateDialog(workflowData.workflows) });
      frag.appendChild(ui.el('div', { class: 'btn-row', style: 'margin-bottom:14px' }, [createBtn]));
    }

    // ---------------------------------------------------------------- table --
    const names = data.processNames || {};
    const tblWrap = ui.el('div', { class: 'table-wrap' });
    tblWrap.appendChild(ui.h(`
      <table class="pe">
        <thead><tr><th>记录号</th><th>标题</th><th>流程</th><th>状态/当前步骤</th><th>严重度</th><th>期限</th></tr></thead>
        <tbody></tbody>
      </table>
    `));
    const tbody = tblWrap.querySelector('tbody');
    for (const r of data.rows) {
      const tr = ui.h(`
        <tr class="clickable" data-href="#/records/${r.id}">
          <td class="mono">${esc(r.recordKey)}</td>
          <td>${esc(r.title)}<div class="small muted">${esc((names[r.processCode] || {}).name || r.processCode)}</div></td>
          <td><span class="badge blue">${esc(r.processCode)}</span></td>
          <td><span class="cell-state"><span class="dot ${esc(r.status)}"></span>${esc(I18N.statusLabel(r.status))}${r.currentStep ? ` · ${esc(r.currentStep)}` : ''}</span></td>
          <td><span class="${esc(r.criticality)}">${esc(r.criticality || '')}</span></td>
          <td>${r.overdue ? `<span class="sev-critical">${ui.fmtDate(r.dueDate)} 超期</span>` : ui.fmtDate(r.dueDate)}</td>
        </tr>`);
      tbody.appendChild(tr);
    }
    if (!data.rows.length && !processCode && !status) {
      // 空库时的新手引导：告诉用户从这里开始三件事
      frag.appendChild(ui.h(`
        <div class="card empty-guide">
          <h3>从这里开始你的第一条分析记录</h3>
          <div class="muted small">药物经济学工作从"方案/文献/模型/报告"这些受控记录开始。每一条记录都是一串有角色门槛、部分需签名的步骤。</div>
          <div class="eg-steps">
            <div class="eg-step"><div class="n">1</div><div class="t">新建记录</div><div class="d">点右上角"+ 新建记录"，选择流程即看到步骤预览</div></div>
            <div class="eg-step"><div class="n">2</div><div class="t">走完步骤</div><div class="d">每一步由声明的角色完成，签名步骤强制双要素电子签名</div></div>
            <div class="eg-step"><div class="n">3</div><div class="t">进领域看流程</div><div class="d">到「领域与流程」查看每个领域的工作流程图与岗位职责</div></div>
          </div>
        </div>
      `));
    } else if (!data.rows.length) {
      tbody.appendChild(ui.h(`<tr><td colspan="6"><div class="empty">没有符合条件的记录。<a href="#/records">清除筛选</a></div></td></tr>`));
    }
    frag.appendChild(tblWrap);
    frag.appendChild(ui.h(`<div class="small muted">共 ${data.total} 条</div>`));

    frag.querySelectorAll('[data-href]').forEach((n) => n.addEventListener('click', () => { location.hash = n.dataset.href; }));

    return frag;

    function applyFilters() {
      const fd = new FormData(form);
      const p = new URLSearchParams();
      if (fd.get('processCode')) p.set('processCode', fd.get('processCode'));
      if (fd.get('status')) p.set('status', fd.get('status'));
      if (fd.get('open') === '1') p.set('open', '1');
      location.hash = '#/records' + (p.toString() ? '?' + p.toString() : '');
    }
  },
});

function openCreateDialog(workflows) {
  const ui = UI;
  const m = ui.modal({ title: '新建记录' });
  const form = ui.el('form', { onsubmit: async (e) => { e.preventDefault(); submit(); } });
  form.appendChild(ui.h(`<label>流程类型</label>`));
  const sel = ui.el('select', { name: 'processCode' });
  for (const w of workflows) {
    const o = document.createElement('option');
    o.value = w.code;
    o.textContent = `${w.code} · ${w.name}`;
    sel.appendChild(o);
  }
  form.appendChild(sel);
  const preview = ui.el('div', { class: 'alert info', style: 'margin-top:10px' });
  form.appendChild(preview);
  form.appendChild(ui.h(`<label>标题（≥3 字）</label>`));
  form.appendChild(ui.el('input', { type: 'text', name: 'title', required: 'required' }));
  form.appendChild(ui.h(`<label>摘要 / 目的</label>`));
  form.appendChild(ui.el('textarea', { name: 'summary' }));
  const row2 = ui.el('div', { class: 'form-row' });
  row2.appendChild(ui.h(`<div><label>严重程度</label><select name="criticality"><option>major</option><option>critical</option><option>minor</option></select></div>`));
  row2.appendChild(ui.h(`<div><label>完成期限</label><input type="date" name="dueDate"></div>`));
  form.appendChild(row2);
  form.appendChild(ui.h(`<label>药品/技术（可选）</label>`));
  form.appendChild(ui.el('input', { type: 'text', name: 'product', placeholder: '如 PE-001' }));
  const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
  form.appendChild(errBox);
  form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">创建</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
  m.content.appendChild(form);

  // 流程选择即预览：创建后会看到什么（借鉴 TreeAge "Build a model step by step" 的引导式体验）
  let previewCache = {};
  sel.addEventListener('change', () => showPreview(sel.value));
  showPreview(sel.value);

  async function showPreview(code) {
    if (previewCache[code]) { preview.innerHTML = previewCache[code]; return; }
    preview.innerHTML = '加载流程预览…';
    try {
      const data = await API.get('/api/workflows/' + code);
      const wf = data.workflow;
      const first = wf.chain[0] || {};
      const sigs = wf.chain.filter((n) => n.signatureMeaning).length;
      previewCache[code] = `
        <strong>创建后将开始：${UI.escapeHtml(first.name || '—')}</strong><br>
        全流程 ${wf.chain.length} 步 · 其中 ${sigs} 步需电子签名 · SLA ${wf.slaDays || '—'} 天<br>
        <span class="small muted">${UI.escapeHtml(first.guidance || wf.description || '')}</span>`;
      preview.innerHTML = previewCache[code];
    } catch {
      preview.innerHTML = '';
    }
  }

  async function submit() {
    const fd = new FormData(form);
    try {
      const res = await API.post('/api/records', {
        processCode: fd.get('processCode'),
        title: fd.get('title'),
        summary: fd.get('summary'),
        criticality: fd.get('criticality'),
        dueDate: fd.get('dueDate') || undefined,
        product: fd.get('product') || undefined,
      });
      m.close();
      UI.toast(`已创建 ${res.record.recordKey}`, 'ok', {
        label: '查看记录 →',
        onClick: () => { location.hash = '#/records/' + res.record.id; },
      });
      location.hash = '#/records/' + res.record.id;
    } catch (err) {
      errBox.style.display = '';
      errBox.textContent = err.message;
    }
  }
}