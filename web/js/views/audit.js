/* PE-Workbench · 审计追踪查看器：哈希链的逐条呈现。 */

window.Views.register('audit', {
  routes: [{ pattern: '/audit' }],
  async render(params, ctx) {
    const ui = UI;
    const esc = UI.escapeHtml;
    const frag = document.createDocumentFragment();
    const query = new URLSearchParams((ctx.hash.split('?')[1]) || '');

    frag.appendChild(ui.h(`<h1>审计追踪 <span class="muted small">/ 只可追加 · 哈希链 · 修改留痕</span></h1>`));
    frag.appendChild(ui.h(`
      <div class="philosophy-quote">理念：审计表禁止 UPDATE 与 DELETE（触发器拦截）；每一行链在前一行上
      （HMAC 链）。绕过数据库的篡改会被摘要比对抓到。<strong>导出审计本身就是一条审计记录</strong>——谁在何时把多少条带出了系统，永远可答。</div>
    `));

    // ------------------------------------------------------------ filters ---
    const filterCard = ui.el('div', { class: 'card' });
    const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); apply(); } });
    const row = ui.el('div', { class: 'form-row' });
    row.appendChild(ui.h(`<div><label>动作</label><input type="text" name="action" placeholder="如 create / sign" value="${esc(query.get('action') || '')}"></div>`));
    row.appendChild(ui.h(`<div><label>对象类型</label><input type="text" name="entityType" placeholder="如 workflow_instances" value="${esc(query.get('entityType') || '')}"></div>`));
    row.appendChild(ui.h(`<div><label>搜索</label><input type="text" name="search" placeholder="记录号 / 操作者 / 理由" value="${esc(query.get('search') || '')}"></div>`));
    form.appendChild(row);
    const btns = ui.el('div', { class: 'btn-row' });
    btns.appendChild(ui.el('button', { class: 'btn primary', type: 'submit', text: '筛选' }));
    if (App.hasPerm('audit.export')) {
      btns.appendChild(ui.el('a', { class: 'btn', href: '/api/audit/export' + (query.toString() ? '?' + query.toString() : ''), text: '导出 CSV（导出本身留痕）' }));
    }
    if (App.hasPerm('audit.verify')) {
      btns.appendChild(ui.el('button', { class: 'btn', text: '校验哈希链', onclick: verifyChain }));
    }
    form.appendChild(btns);
    filterCard.appendChild(form);
    frag.appendChild(filterCard);

    // ---------------------------------------------------------------- table --
    const limit = 60;
    const data = await API.get('/api/audit?limit=' + limit + (query.toString() ? '&' + query.toString() : ''));
    const tableCard = ui.el('div', { class: 'card' });
    tableCard.appendChild(ui.h(`<div class="small muted">共 ${data.total} 条，显示最近 ${data.rows.length} 条</div>`));
    const tbl = ui.el('div', { class: 'table-wrap', style: 'margin-top:8px' });
    tbl.appendChild(ui.h(`
      <table class="pe"><thead><tr><th>seq</th><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>记录号</th><th>理由</th><th>链哈希</th></tr></thead><tbody></tbody></table>
    `));
    const tbody = tbl.querySelector('tbody');
    for (const r of data.rows) {
      tbody.appendChild(ui.h(`
        <tr>
          <td class="mono">${r.seq}</td>
          <td class="small mono">${esc(String(r.at).slice(0, 19))}</td>
          <td>${esc(r.actor_name || r.actor_username || 'system')} <span class="small muted">${esc(r.actor_role || '')}</span></td>
          <td><span class="badge ${r.severity === 'critical' ? 'red' : r.severity === 'warning' ? 'amber' : 'gray'}">${esc(r.action)}</span></td>
          <td class="small">${esc(r.entity_type)}${r.entity_id != null ? '#' + esc(r.entity_id) : ''}</td>
          <td class="mono small">${esc(r.record_key || '')}</td>
          <td class="small" style="max-width:260px">${esc(String(r.reason || '').slice(0, 90))}</td>
          <td class="mono small" title="${esc(r.chain_hash)}">${esc(String(r.chain_hash).slice(0, 10))}…</td>
        </tr>`));
    }
    if (!data.rows.length) tbody.appendChild(ui.h(`<tr><td colspan="8"><div class="empty">无匹配记录。</div></td></tr>`));
    tableCard.appendChild(tbl);
    frag.appendChild(tableCard);

    return frag;

    function apply() {
      const fd = new FormData(form);
      const p = new URLSearchParams();
      for (const key of ['action', 'entityType', 'search']) {
        const v = fd.get(key);
        if (v) p.set(key, v);
      }
      location.hash = '#/audit' + (p.toString() ? '?' + p.toString() : '');
    }

    async function verifyChain() {
      try {
        const res = await API.post('/api/audit/verify', {});
        const r = res.result;
        const m = ui.modal({ title: '审计链校验' });
        if (r.ok) {
          m.content.appendChild(ui.h(`<div class="alert ok"><strong>完整 ✓</strong> 已校验 ${r.checked} 条记录，链尾哈希：<span class="mono">${esc(r.lastHash.slice(0, 24))}…</span></div>`));
        } else {
          m.content.appendChild(ui.h(`<div class="alert err"><strong>校验失败</strong> 断点：seq ${r.brokenAt}<br>${esc(r.reason)}</div>`));
        }
      } catch (err) { UI.toastError(err); }
    }
  },
});