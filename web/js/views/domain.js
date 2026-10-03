/* PE-Workbench · 领域专属界面。
 *
 * 一个界面看全一个领域：理念 → 工作流程图（每步下面是负责人与签名门槛）→
 * 流程清单 → 岗位职责（受限岗位灰显并说明理由）→ 三态权限矩阵 → 检查表 →
 * 约束清单。流程图不是悬浮提示里的说明，而是直接写在图上。
 */

window.Views.register('domain', {
  routes: [{ pattern: '/domain/:code' }],
  async render(params) {
    const data = await API.get('/api/domains/' + params.code);
    const d = data.domain;
    const ui = UI;
    const frag = document.createDocumentFragment();
    const esc = UI.escapeHtml;

    frag.appendChild(ui.h(`
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <h1>${esc(d.code)} · ${esc(d.name)} <span class="muted small">${esc(d.nameEn)}</span></h1>
        <a class="btn small" href="#/domains">← 全部领域</a>
      </div>
    `));
    frag.appendChild(ui.h(`<div class="philosophy-quote"><strong>本领域理念：</strong>${esc(d.philosophy || '')}<span class="src">${esc(d.description)}</span></div>`));

    // -------------------------------------------------------- workflow flow --
    frag.appendChild(ui.h(`<h2>工作流程图 <span class="muted small">/ 谁在哪个步骤做什么、哪些步骤需要签名</span></h2>`));
    if (!d.cascade.length) {
      frag.appendChild(ui.h(`<div class="empty">该领域暂无专属工作流。</div>`));
    } else {
      for (const p of d.cascade) {
        const card = ui.el('div', { class: 'card' });
        card.appendChild(ui.h(`
          <h3><a href="#/workflow/${esc(p.code)}">${esc(p.code)} · ${esc(p.name)}</a>
          <span class="muted small">/ SLA ${p.slaDays || '—'} 天</span></h3>
        `));
        const flow = ui.el('div', { class: 'flow' });
        p.steps.forEach((s, idx) => {
          const node = ui.h(`
            <div class="fstep ${idx === 0 ? 'next' : ''}">
              <span class="seq">${idx + 1}</span>
              <div class="typ">${s.signatureMeaning ? '✍ 需签名' : '任务'}</div>
              <div class="nm">${esc(s.name)}</div>
              <div class="roles">${(s.roles || []).map((r) => `<span class="pill">${esc(roleLabel(r))}</span>`).join('') || '<span class="pill">—</span>'}</div>
              ${s.signatureMeaning ? `<div class="sig">签名含义：${esc(s.signatureMeaning)}</div>` : ''}
            </div>`);
          flow.appendChild(node);
          if (idx < p.steps.length - 1) flow.appendChild(ui.h(`<div class="arrow">→</div>`));
        });
        card.appendChild(flow);
        frag.appendChild(card);
      }
    }

    // ---------------------------------------------------------- role cards ----
    frag.appendChild(ui.h(`<h2>岗位职责 <span class="muted small">/ 灰显岗位不在你的可见范围内，点击可看理由</span></h2>`));
    const roleGrid = ui.el('div', { class: 'grid c3' });
    for (const rc of d.roleCards) {
      const card = ui.el('div', { class: 'card', style: 'opacity:' + (rc.visible ? '1' : '.55') });
      card.innerHTML = `
        <h3>${esc(rc.label)} <span class="muted small">${rc.stepsInDomain} 个步骤</span></h3>
        <div class="card-sub">${esc(rc.description || '')}</div>
        ${(rc.signatureMeanings || []).length ? `<div class="btn-row">${rc.signatureMeanings.map((m) => `<span class="pill">✍ ${esc(m)}</span>`).join('')}</div>` : ''}
        <div class="small muted" style="margin-top:8px">${rc.visible ? '职责内可查看' : '受限：' + esc(rc.visibilityReason || '')}</div>
        <div class="btn-row" style="margin-top:8px">
          <span class="pill">${rc.permissionCount} 项权限</span>
        </div>
      `;
      if (!rc.visible) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
          const m = ui.modal({ title: `${rc.label} · 受限岗位` });
          m.content.appendChild(ui.h(`<div class="alert info">${esc(rc.visibilityReason || '')}</div>`));
          m.content.appendChild(ui.h(`<div class="small muted">该岗位对你仅公开：岗位名、职责、权限数量。人员信息按职能关系判定可见性，不按行政级别。</div>`));
        });
      }
      roleGrid.appendChild(card);
    }
    frag.appendChild(roleGrid);

    // --------------------------------------------------- permission matrix ----
    frag.appendChild(ui.h(`<h2>信息权限对应表 <span class="muted small">/ 三态：允许 · 不允许 · ⚠ 有约束（代码强制）</span></h2>`));
    const matrixCard = ui.el('div', { class: 'card' });
    const matrix = ui.el('div', { class: 'matrix' });
    matrix.appendChild(ui.h(`
      <table>
        <thead><tr><th>权限</th>${d.roleCards.map((rc) => `<th>${esc(rc.label)}</th>`).join('')}</tr></thead>
        <tbody></tbody>
      </table>
    `));
    const tbody = matrix.querySelector('tbody');
    for (const row of d.matrix) {
      const tr = ui.el('tr');
      tr.appendChild(ui.h(`<td class="perm">${esc(row.label)}<div class="small muted mono">${esc(row.permission)}</div></td>`));
      for (const rc of d.roleCards) {
        const cell = row.cells[rc.role];
        const td = ui.el('td');
        if (!cell || cell.state === 'denied') {
          td.innerHTML = `<span class="denied">✗ 不允许</span>`;
        } else if (cell.state === 'conditional') {
          td.innerHTML = `<span class="conditional" title="${esc(cell.reason)}">⚠ 有约束</span>`;
          td.querySelector('.conditional').addEventListener('click', () => {
            const m = ui.modal({ title: '有约束权限' });
            m.content.appendChild(ui.h(`<div class="alert warn"><strong>${esc(cell.reason)}</strong></div>`));
            m.content.appendChild(ui.h(`<div class="small muted">方法学依据：${esc(cell.basis || '')}<br>代码位置：<span class="mono">${esc(cell.enforced || '')}</span></div>`));
          });
        } else {
          td.innerHTML = `<span class="allowed">✓ 允许</span>`;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    matrixCard.appendChild(matrix);
    frag.appendChild(matrixCard);

    // ----------------------------------------------------------- records -----
    if (d.records.length) {
      frag.appendChild(ui.h(`<h2>该领域进行中的记录</h2>`));
      const recTbl = ui.el('div', { class: 'table-wrap' });
      recTbl.appendChild(ui.h(`
        <table class="pe"><thead><tr><th>记录号</th><th>标题</th><th>流程</th><th>状态</th><th>期限</th></tr></thead><tbody></tbody></table>
      `));
      const tbody2 = recTbl.querySelector('tbody');
      for (const r of d.records) {
        const tr = ui.h(`
          <tr class="clickable" data-href="#/records/${r.id != null ? r.id : ''}">
            <td class="mono">${esc(r.recordKey)}</td><td>${esc(r.title)}</td>
            <td>${esc(r.processCode)}</td>
            <td><span class="cell-state"><span class="dot ${esc(r.status)}"></span>${esc(statusLabel(r.status))}</span></td>
            <td>${r.overdue ? `<span class="sev-critical">${ui.fmtDate(r.dueDate)} 已超期</span>` : ui.fmtDate(r.dueDate)}</td>
          </tr>`);
        tbody2.appendChild(tr);
      }
      frag.appendChild(recTbl);
    }

    // ------------------------------------------------------ checklists -------
    if (d.checklists.length) {
      frag.appendChild(ui.h(`<h2>覆盖本领域的检查表 <span class="muted small">/ 报告与模型的'照妖镜'</span></h2>`));
      const clGrid = ui.el('div', { class: 'grid c3' });
      for (const c of d.checklists) {
        const card = ui.el('div', { class: 'card', style: 'cursor:pointer' });
        card.innerHTML = `<h3>${esc(c.title)}</h3><div class="card-sub">${esc(c.code)} · ${c.itemCount} 项要求</div>`;
        card.addEventListener('click', () => { location.hash = '#/checklists/' + c.code; });
        clGrid.appendChild(card);
      }
      frag.appendChild(clGrid);
    }

    return frag;
  },
});

function roleLabel(role) {
  return role;
}
function statusLabel(s) {
  return window.I18N.statusLabel(s);
}