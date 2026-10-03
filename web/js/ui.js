/* PE-Workbench · DOM 与组件助手。
 *
 * 全部为小型零依赖助手。签名对话框是唯一应用电子签名的地方：它收集两个
 * 独立识别要素（密码 + TOTP 或一次性挑战码），且从不缓存凭证。
 */

window.UI = (function () {
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      for (const c of (Array.isArray(children) ? children : [children])) {
        if (c === null || c === undefined) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function h(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function fmtMoney(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return String(iso).slice(0, 10);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --------------------------------------------------------------- toast ----
  function toast(message, kind, action) {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = el('div', { class: 'toast-wrap' });
      document.body.appendChild(wrap);
    }
    const t = el('div', { class: 'toast' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '') });
    t.appendChild(document.createTextNode(message));
    if (action && action.label) {
      const btn = el('button', {
        class: 'toast-act',
        text: action.label,
        onclick: () => { t.remove(); if (action.onClick) action.onClick(); },
      });
      t.appendChild(btn);
    }
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3600);
    setTimeout(() => t.remove(), 4000);
  }

  function toastError(err) {
    toast((err && err.message) || '操作失败', 'err');
  }

  // --------------------------------------------------------------- modal ----
  let openModal = null;

  function modal({ title, body, onClose }) {
    closeModal();
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', { class: 'modal' });
    box.appendChild(h(`<h3>${escapeHtml(title || '')} <button class="modal-x" data-close="1">✕</button></h3>`));
    const content = el('div', { class: 'modal-body' });
    box.appendChild(content);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    openModal = backdrop;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.dataset.close) {
        closeModal();
        if (onClose) onClose();
      }
    });
    return { backdrop, content, close: () => { closeModal(); if (onClose) onClose(); } };
  }

  function closeModal() {
    if (openModal) { openModal.remove(); openModal = null; }
  }

  // ------------------------------------------------ confirm / prompt -------
  function confirmDialog(title, message, { okText = '确认', danger = false } = {}) {
    return new Promise((resolve) => {
      const m = modal({ title });
      m.content.appendChild(el('p', { text: message }));
      const row = el('div', { class: 'btn-row' });
      row.appendChild(el('button', { class: 'btn' + (danger ? ' danger' : ' primary'), text: okText, onclick: () => { m.close(); resolve(true); } }));
      row.appendChild(el('button', { class: 'btn', text: '取消', onclick: () => { m.close(); resolve(false); } }));
      m.content.appendChild(row);
    });
  }

  // ------------------------------------------------------- signature --------
  /**
   * 电子签名对话框：收集 密码（分量 A）+ TOTP 或一次性挑战码（分量 B）。
   * 挑战码在打开对话框时获取；若服务端要求第二要素而用户未提供，则显示 TOTP 输入。
   */
  async function signatureDialog({ title, meaning, meaningLabel, entityType, entityId, recordKey, stepCode, username, requireSecondFactor }) {
    const challenge = await API.post('/api/signatures/challenge', { purpose: 'signature' }).catch(() => ({ nonce: null }));
    return new Promise((resolve) => {
      let settled = false;
      const m = modal({
        title: title || '电子签名',
        onClose: () => { if (!settled) { settled = true; resolve(null); } },
      });
      const form = el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
      form.appendChild(h(`
        <div class="alert info">签名含义：<strong>${escapeHtml(meaningLabel || meaning)}</strong><br>
        签名需要两个独立识别要素：密码 + 一次性挑战码（或动态口令）。</div>
      `));
      form.appendChild(h(`<label>识别码（用户名）</label>`));
      form.appendChild(el('input', { type: 'text', name: 'username', value: username || '', required: true }));
      form.appendChild(h(`<label>密码</label>`));
      form.appendChild(el('input', { type: 'password', name: 'password', required: true }));
      const totpRow = el('div', { class: 'totp-row', style: 'display:none' });
      totpRow.appendChild(h(`<label>动态口令（TOTP，如已绑定）</label>`));
      totpRow.appendChild(el('input', { type: 'text', name: 'totp', placeholder: '6 位数字' }));
      form.appendChild(totpRow);
      form.appendChild(h(`<label>签名理由（至少 3 个字）</label>`));
      form.appendChild(el('textarea', { name: 'reason', required: 'required', minlength: '3', placeholder: '我签署此步骤的理由…（审计留痕）' }));
      const errBox = el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      const row = el('div', { class: 'btn-row' });
      const submitBtn = el('button', { class: 'btn primary', type: 'submit', text: '签署并提交' });
      row.appendChild(submitBtn);
      row.appendChild(el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => m.close() }));
      form.appendChild(row);
      m.content.appendChild(form);

      async function submit() {
        const fd = new FormData(form);
        const payload = {
          username: fd.get('username'), password: fd.get('password'),
          reason: fd.get('reason'), meaning,
          entityType, entityId: String(entityId), recordKey, stepCode,
          nonce: challenge && challenge.nonce ? challenge.nonce : null,
          totp: fd.get('totp') || null,
        };
        submitBtn.disabled = true;
        try {
          const res = await API.post('/api/signatures', payload);
          if (res.ok === false) {
            throw Object.assign(new Error(res.message || '签名失败'), { code: res.code });
          }
          settled = true;
          m.close();
          resolve(res);
        } catch (err) {
          submitBtn.disabled = false;
          if (err.code === 'SECOND_FACTOR_REQUIRED' || err.code === 'TOTP_INVALID' || err.code === 'TOTP_NOT_ENROLLED') {
            totpRow.style.display = '';
            errBox.style.display = '';
            errBox.textContent = err.message + ' 请输入动态口令。';
            return;
          }
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
    });
  }

  // --------------------------------------------- global quick search box ----
  const KIND_LABEL = { record: '记录', document: '文件', workflow: '流程', assessment: '检查', user: '用户' };
  const KIND_CLASS = { record: 'blue', document: 'purple', workflow: 'teal', assessment: 'amber', user: 'gray' };

  /**
   * Top-bar search with result dropdown (Ctrl+K / "/" shortcut wired by app.js).
   */
  function searchBox() {
    const wrap = el('div', { class: 'top-search' });
    const input = el('input', { type: 'text', placeholder: '搜索记录 / 文件 / 流程…（Ctrl+K）', autocomplete: 'off' });
    wrap.appendChild(input);
    wrap.appendChild(h('<span class="search-kbd">Ctrl K</span>'));
    const pop = el('div', { class: 'search-pop' });
    wrap.appendChild(pop);

    let items = [];
    let sel = -1;
    let lastTerm = '';
    let timer = null;

    function close() {
      pop.classList.remove('open');
      sel = -1;
    }

    function render(list) {
      pop.innerHTML = '';
      items = list || [];
      sel = -1;
      if (!items.length) {
        pop.appendChild(h('<div class="s-empty">没有匹配的内容。试试记录号、标题或人员姓名。</div>'));
      } else {
        items.forEach((it, idx) => {
          const b = el('button', {
            class: 's-item',
            type: 'button',
            onclick: () => go(it),
          });
          b.innerHTML = `
            <span class="s-kind"><span class="pill color" style="background:${KIND_CLASS[it.kind] === 'blue' ? '#0e7490' : KIND_CLASS[it.kind] === 'purple' ? '#6d28d9' : KIND_CLASS[it.kind] === 'teal' ? '#0f766e' : KIND_CLASS[it.kind] === 'amber' ? '#b45309' : '#475569'}">${KIND_LABEL[it.kind] || it.kind}</span></span>
            <span style="flex:1;min-width:0"><span class="s-title">${escapeHtml(it.title)}</span><div class="s-sub">${escapeHtml(it.subtitle || '')}</div></span>
          `;
          b.dataset.idx = String(idx);
          pop.appendChild(b);
        });
      }
      pop.classList.add('open');
    }

    function go(it) {
      close();
      input.value = '';
      if (it && it.href) location.hash = it.href;
      input.blur();
    }

    function move(dir) {
      if (!items.length) return;
      sel = (sel + dir + items.length) % items.length;
      pop.querySelectorAll('.s-item').forEach((n) => {
        n.classList.toggle('sel', Number(n.dataset.idx) === sel);
      });
      const cur = pop.querySelector('.s-item.sel');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      if (q === lastTerm) return;
      timer = setTimeout(async () => {
        lastTerm = q;
        try {
          const data = await API.get('/api/search?q=' + encodeURIComponent(q) + '&limit=8');
          render(data.results || []);
        } catch { close(); }
      }, 300);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (sel >= 0 && items[sel]) go(items[sel]);
        else if (items[0]) go(items[0]);
      } else if (e.key === 'Escape') { close(); input.blur(); }
    });

    input.addEventListener('blur', () => setTimeout(close, 120));
    wrap.addEventListener('mousedown', (e) => {
      if (!pop.contains(e.target)) setTimeout(close, 120);
    });
    return wrap;
  }

  // -------------------------------------------- onboarding spot positioning --
  /** Returns {top, left, width} for a fixed-position card anchored to the
   *  element, keeping the card inside the viewport. */
  function anchorFor(node, cardW, cardH) {
    const r = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.right + 12;
    let top = r.top;
    if (left + cardW > vw - 8) left = Math.max(8, r.left - cardW - 12);
    if (top + cardH > vh - 8) top = Math.max(8, vh - cardH - 8);
    return { top, left };
  }

  return {
    el, h, clear, toast, toastError, modal, closeModal, confirmDialog,
    signatureDialog, searchBox, anchorFor, fmtMoney, fmtDate, escapeHtml,
  };
})();