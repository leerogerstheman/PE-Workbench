/* PE-Workbench · 单条工作流页：完整责任移交链 + 参与者 + 三态矩阵 + 约束。 */

window.Views.register('workflow', {
  routes: [{ pattern: '/workflow/:code' }],
  async render(params) {
    const data = await API.get('/api/workflows/' + params.code);
    const w = data.workflow;
    const ui = UI;
    const frag = document.createDocumentFragment();
    const esc = UI.escapeHtml;

    frag.appendChild(ui.h(`
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <h1>${esc(w.code)} · ${esc(w.name)} <span class="muted small">${esc(w.nameEn)}</span></h1>
        <a class="btn small" href="#/domains">← 领域与流程</a>
      </div>
    `));
    frag.appendChild(ui.h(`<div class="alert info">${esc(w.description || '')}<br>
      <span class="small muted">SLA ${w.slaDays || '—'} 天 · 记录统计：共 ${w.recordStats.total} 条，进行中 ${w.recordStats.open} 条</span>
    </div>`));

    // ---------------------------------------------------------------- chain --
    frag.appendChild(ui.h(`<h2>责任移交链 <span class="muted small">/ 每一步：谁来做、做什么、要不要签名、从谁接手</span></h2>`));
    const chainCard = ui.el('div', { class: 'card' });
    const chain = ui.el('div', { class: 'chain' });
    for (const node of w.chain) {
      const item = ui.el('div', { class: 'cnode' });
      let html = `
        <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
          <strong>${node.seq}. ${esc(node.name)}</strong>
          ${node.signatureMeaning ? `<span class="badge amber">✍ 签名：${esc(node.signatureMeaning)}</span>` : '<span class="badge gray">任务</span>'}
          ${node.independentOfAuthor ? '<span class="badge purple">独立于作者</span>' : ''}
        </div>
        <div class="small muted">${esc(node.nameEn || '')}</div>
      `;
      if (node.handoverFrom && node.handoverFrom.length) {
        html += `<div class="handover">接手自：${node.handoverFrom.map(esc).join(' / ')}</div>`;
      }
      html += `<div class="btn-row" style="margin-top:6px">${node.roleLabels.map((r) => `<span class="pill">${esc(r)}</span>`).join('') || '<span class="pill">—</span>'}</div>`;
      if (node.requiresFields && node.requiresFields.length) {
        html += `<div class="small muted">必填：${node.requiresFields.map(esc).join('、')}</div>`;
      }
      if (node.guidance) {
        html += `<div class="small" style="color:#0e7490;margin-top:6px">💡 ${esc(node.guidance)}</div>`;
      }
      item.innerHTML = html;
      chain.appendChild(item);
    }
    chainCard.appendChild(chain);
    frag.appendChild(chainCard);

    // ---------------------------------------------------------- participants -
    frag.appendChild(ui.h(`<h2>参与者 <span class="muted small">/ 岗位不是标签，绑定的是权限与服务端步骤门</span></h2>`));
    const pGrid = ui.el('div', { class: 'grid c3' });
    for (const p of w.participants) {
      const card = ui.el('div', { class: 'card' });
      card.innerHTML = `
        <h3>${esc(p.label)} <span class="muted small mono">${esc(p.role)}</span></h3>
        <div class="card-sub">${esc(p.description || '')}</div>
        <div class="small"><strong>在本流程中的步骤：</strong>${(p.stepsHeld || []).map(esc).join(' → ') || '—'}</div>
        ${(p.signatureMeanings || []).length ? `<div class="small" style="margin-top:6px"><strong>签名含义：</strong>${p.signatureMeanings.map(esc).join(' / ')}</div>` : ''}
        <div class="small muted" style="margin-top:6px">${p.permissions.length} 项权限</div>
      `;
      pGrid.appendChild(card);
    }
    frag.appendChild(pGrid);

    // --------------------------------------------------------------- matrix --
    frag.appendChild(ui.h(`<h2>权限矩阵 <span class="muted small">/ ⚠ 有约束 = 服务端仍会拒绝的代码强制</span></h2>`));
    const mCard = ui.el('div', { class: 'card' });
    mCard.appendChild(ui.h(`
      <div class="matrix"><table>
        <thead><tr><th>权限</th>${w.participants.map((p) => `<th>${esc(p.label)}</th>`).join('')}</tr></thead>
        <tbody></tbody>
      </table></div>
    `));
    const tbody = mCard.querySelector('tbody');
    for (const row of w.matrix) {
      const tr = ui.el('tr');
      tr.appendChild(ui.h(`<td class="perm">${esc(row.label)}<div class="small muted mono">${esc(row.permission)}</div></td>`));
      for (const p of w.participants) {
        const cell = row.cells[p.role];
        const td = ui.el('td');
        if (!cell || cell.state === 'denied') td.innerHTML = '<span class="denied">✗</span>';
        else if (cell.state === 'conditional') {
          td.innerHTML = `<span class="conditional" title="${esc(cell.reason)}">⚠</span>`;
          td.querySelector('.conditional').addEventListener('click', () => {
            const m = ui.modal({ title: '有约束权限' });
            m.content.appendChild(ui.h(`<div class="alert warn"><strong>${esc(cell.reason)}</strong></div>`));
            m.content.appendChild(ui.h(`<div class="small muted">依据：${esc(cell.basis || '')}<br>代码位置：<span class="mono">${esc(cell.enforced || '')}</span></div>`));
          });
        }
        else td.innerHTML = '<span class="allowed">✓</span>';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    frag.appendChild(mCard);

    // ---------------------------------------------------------- constraints ---
    frag.appendChild(ui.h(`<h2>代码强制约束 <span class="muted small">/ 界面说"允许"不代表内核不拒绝</span></h2>`));
    const cCard = ui.el('div', { class: 'card' });
    const cl = ui.el('div', { class: 'grid c2' });
    for (const c of w.constraints) {
      const item = ui.el('div', { class: 'checklist-item' });
      item.innerHTML = `
        <div class="req">${esc(c.name)} <span class="badge ${c.effect === 'denied' ? 'red' : 'amber'}">${c.effect === 'denied' ? '绝对拒绝' : '有条件'}</span></div>
        <div class="ref mono">${esc(c.code)}</div>
        <div class="gd">${esc(c.description)}</div>
        <div class="small muted">依据：${esc(c.basis || '')}<br>代码位置：<span class="mono">${esc(c.enforced || '')}</span></div>
      `;
      cl.appendChild(item);
    }
    cCard.appendChild(cl);
    frag.appendChild(cCard);

    // ---------------------------------------------------- regulation refs ----
    if (w.regulationRefs && w.regulationRefs.length) {
      frag.appendChild(ui.h(`<h2>方法学依据 <span class="muted small">/ 这条流程为什么长这样</span></h2>`));
      const refCard = ui.el('div', { class: 'card' });
      refCard.appendChild(ui.h(`<ul class="small">${w.regulationRefs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`));
      frag.appendChild(refCard);
    }

    return frag;
  },
});