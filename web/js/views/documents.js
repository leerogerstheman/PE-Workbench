/* PE-Workbench · 文件控制：方案/SOP/模板/报告的版本生命周期与阅知。 */

window.Views.register('documents', {
  routes: [
    { pattern: '/documents' },
    { pattern: '/documents/:id' },
  ],
  async render(params, ctx) {
    const ui = UI;
    const esc = UI.escapeHtml;
    const frag = document.createDocumentFragment();

    if (params.id) return await renderDetail(params.id);

    const data = await API.get('/api/documents');
    frag.appendChild(ui.h(`<h1>文件控制 <span class="muted small">/ 方案、规程、模板——版本不可变、批准需签名、定期审核</span></h1>`));
    if (App.hasPerm('doc.create')) {
      const btn = ui.el('button', { class: 'btn primary', text: '+ 新建文件', onclick: () => openCreate() });
      frag.appendChild(ui.el('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [btn]));
    }
    const card = ui.el('div', { class: 'card' });
    const tbl = ui.el('div', { class: 'table-wrap' });
    tbl.appendChild(ui.h(`
      <table class="pe"><thead><tr><th>文件号</th><th>标题</th><th>类型</th><th>版本</th><th>状态</th><th>下次审核</th></tr></thead><tbody></tbody></table>
    `));
    const tbody = tbl.querySelector('tbody');
    for (const d of data.documents) {
      tbody.appendChild(ui.h(`
        <tr class="clickable" data-href="#/documents/${d.id}">
          <td class="mono">${esc(d.docNumber)}</td><td>${esc(d.title)}</td>
          <td><span class="badge blue">${esc(d.docType)}</span></td>
          <td class="mono">${esc(d.currentVersion || '—')}</td>
          <td><span class="badge ${d.status === 'effective' ? 'green' : d.status === 'obsolete' ? 'gray' : 'blue'}">${esc(d.status)}</span></td>
          <td>${d.reviewOverdue ? `<span class="sev-critical">${ui.fmtDate(d.nextReviewDate)} 已超期</span>` : ui.fmtDate(d.nextReviewDate)}</td>
        </tr>`));
    }
    if (!data.documents.length) tbody.appendChild(ui.h(`<tr><td colspan="6"><div class="empty">还没有受控文件。</div></td></tr>`));
    card.appendChild(tbl);
    frag.appendChild(card);
    frag.querySelectorAll('[data-href]').forEach((n) => n.addEventListener('click', () => { location.hash = n.dataset.href; }));
    return frag;

    async function renderDetail(id) {
      const data = await API.get('/api/documents/' + id);
      const d = data.document;
      frag.appendChild(ui.h(`
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
          <h1><span class="mono">${esc(d.docNumber)}</span> · ${esc(d.title)}</h1>
          <a class="btn small" href="#/documents">← 文件列表</a>
        </div>
      `));
      frag.appendChild(ui.h(`<div class="small muted">${esc(d.titleEn || '')} · 当前版本 <span class="mono">${esc(d.currentVersion || '—')}</span> · 状态 ${esc(d.status)} · 下次审核 ${ui.fmtDate(d.nextReviewDate)}</div>`));

      const card = ui.el('div', { class: 'card' });
      card.appendChild(ui.h(`<h3>版本历史 <span class="muted small">/ 已批准版本不可变</span></h3>`));
      const tbl = ui.el('div', { class: 'table-wrap' });
      tbl.appendChild(ui.h(`<table class="pe"><thead><tr><th>版本</th><th>状态</th><th>变更原因</th><th>生效日期</th><th>操作</th></tr></thead><tbody></tbody></table>`));
      const tbody = tbl.querySelector('tbody');
      for (const v of d.versions) {
        const tr = ui.el('tr');
        tr.appendChild(ui.h(`<td class="mono">${esc(v.version)}</td><td><span class="badge ${v.status === 'effective' ? 'green' : 'blue'}">${esc(v.status)}</span></td><td class="small">${esc(v.changeReason || v.changeSummary || '')}</td><td>${ui.fmtDate(v.effectiveDate)}</td>`));
        const td = ui.el('td');
        if (App.hasPerm('doc.edit') && !v.content) {
          // allow creating a new version instead
        }
        if (App.hasPerm('doc.approve') && v.status === 'draft') {
          const b = ui.el('button', { class: 'btn small', text: '✍ 批准', onclick: () => approve(v) });
          td.appendChild(b);
        }
        if (v.content) {
          const b = ui.el('button', { class: 'btn small', text: '查看内容', onclick: () => {
            const m = ui.modal({ title: `${d.docNumber} ${v.version}` });
            const pre = document.createElement('pre');
            pre.textContent = v.content;
            pre.style.whiteSpace = 'pre-wrap';
            pre.style.fontSize = '12.5px';
            m.content.appendChild(pre);
          } });
          td.appendChild(b);
        }
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      card.appendChild(tbl);

      if (App.hasPerm('doc.edit')) {
        const row = ui.el('div', { class: 'btn-row' });
        row.appendChild(ui.el('button', { class: 'btn', text: '+ 新建版本', onclick: () => openVersion() }));
        row.appendChild(ui.el('button', { class: 'btn small', text: '标记已阅知', onclick: async () => {
          try { await API.post(`/api/documents/${d.id}/read`, { versionId: d.versions.length ? d.versions[d.versions.length - 1].id : null }); UI.toast('已记录阅知', 'ok'); }
          catch (err) { UI.toastError(err); }
        } }));
        if (App.hasPerm('doc.obsolete')) {
          row.appendChild(ui.el('button', { class: 'btn danger', text: '废止文件', onclick: () => obsolete() }));
        }
        card.appendChild(row);
      }
      frag.appendChild(card);
      return frag;

      async function approve(v) {
        const me = App.currentUser();
        const sig = await UI.signatureDialog({
          title: `批准 ${d.docNumber} ${v.version}`,
          meaning: 'approved', meaningLabel: '批准',
          entityType: 'document_versions', entityId: v.id,
          recordKey: `documents:${d.id}`, stepCode: null,
          username: me ? me.username : '',
        });
        if (!sig) return;
        try {
          await API.post(`/api/documents/${d.id}/versions/${v.id}/approve`, { signatureId: sig.signature.id });
          UI.toast('版本已批准并生效', 'ok');
          App.route();
        } catch (err) { UI.toastError(err); }
      }

      function openVersion() {
        const m = ui.modal({ title: `新建版本 ${d.docNumber}` });
        const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
        form.appendChild(ui.h(`<label>版本号（默认自动递增）</label>`));
        form.appendChild(ui.el('input', { type: 'text', name: 'version', placeholder: '如 V1.1' }));
        form.appendChild(ui.h(`<label>变更原因（必填）</label>`));
        form.appendChild(ui.el('textarea', { name: 'changeReason', required: 'required', minlength: '3' }));
        form.appendChild(ui.h(`<label>内容（可选）</label>`));
        form.appendChild(ui.el('textarea', { name: 'content' }));
        const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
        form.appendChild(errBox);
        form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">创建版本</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
        m.content.appendChild(form);
        async function submit() {
          const fd = new FormData(form);
          try {
            await API.post(`/api/documents/${d.id}/versions`, {
              version: fd.get('version') || undefined,
              changeReason: fd.get('changeReason'),
              content: fd.get('content') || undefined,
            });
            m.close();
            UI.toast('新版本已创建（草稿）', 'ok');
            App.route();
          } catch (err) {
            errBox.style.display = '';
            errBox.textContent = err.message;
          }
        }
      }

      function obsolete() {
        const m = ui.modal({ title: `废止 ${d.docNumber}` });
        const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
        form.appendChild(ui.h(`<label>废止理由（≥10 字）</label>`));
        form.appendChild(ui.el('textarea', { name: 'reason', required: 'required', minlength: '10' }));
        const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
        form.appendChild(errBox);
        form.appendChild(ui.h(`<div class="btn-row"><button class="btn danger" type="submit">废止</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
        m.content.appendChild(form);
        async function submit() {
          const fd = new FormData(form);
          try {
            await API.post(`/api/documents/${d.id}/obsolete`, { reason: fd.get('reason') });
            m.close();
            UI.toast('文件已废止', 'ok');
            App.route();
          } catch (err) {
            errBox.style.display = '';
            errBox.textContent = err.message;
          }
        }
      }
    }

    function openCreate() {
      const m = ui.modal({ title: '新建受控文件' });
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
      form.appendChild(ui.h(`<label>标题（≥3 字）</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'title', required: 'required' }));
      form.appendChild(ui.h(`<label>类型</label>`));
      const sel = ui.el('select', { name: 'docType' });
      for (const t of ['protocol', 'sop', 'template', 'manual', 'dossier', 'report']) {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        sel.appendChild(o);
      }
      form.appendChild(sel);
      form.appendChild(ui.h(`<label>领域（逗号分隔，如 RSD,CST）</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'gxpAreas', placeholder: 'RSD,CST' }));
      form.appendChild(ui.h(`<label>摘要</label>`));
      form.appendChild(ui.el('textarea', { name: 'summary' }));
      form.appendChild(ui.h(`<label>内容（可选，作为 V1.0）</label>`));
      form.appendChild(ui.el('textarea', { name: 'content' }));
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">创建</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
      m.content.appendChild(form);
      async function submit() {
        const fd = new FormData(form);
        try {
          const res = await API.post('/api/documents', {
            title: fd.get('title'), docType: fd.get('docType'),
            gxpAreas: String(fd.get('gxpAreas')).split(',').map((s) => s.trim()).filter(Boolean),
            summary: fd.get('summary') || undefined,
            content: fd.get('content') || undefined,
          });
          m.close();
          UI.toast(`已创建 ${res.document.docNumber}`, 'ok');
          location.hash = '#/documents/' + res.document.id;
        } catch (err) {
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
    }
  },
});