/* PE-Workbench · API client.
 *
 * Thin wrapper over fetch that centralises three behaviours:
 *   1. the session cookie is always sent;
 *   2. a 401 with SESSION_ENDED is surfaced globally so the shell can explain
 *      WHY the user was signed out (idle timeout vs lockout vs expiry);
 *   3. server errors arrive as {error, message} and are rethrown as Error with
 *      .code/.status so views can react (e.g. signature needs a second factor).
 */

window.API = (function () {
  async function request(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      throw new Error('无法连接本地服务，请确认工作台已启动 (127.0.0.1:8798)。');
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(text || '导出失败');
        err.status = res.status;
        throw err;
      }
      return { _raw: text, _headers: Object.fromEntries(res.headers.entries()) };
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }

    if (res.status === 401 && data && data.error === 'SESSION_ENDED') {
      window.App && window.App.onSessionEnded(data.code, data.message);
      const err = new Error(data.message || '会话已结束');
      err.code = data.code;
      err.status = 401;
      throw err;
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || `请求失败 (${res.status})`);
      err.code = data && data.error;
      err.status = res.status;
      err.details = data && data.details;
      throw err;
    }
    return data;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body || {}),
    patch: (path, body) => request('PATCH', path, body || {}),
    del: (path) => request('DELETE', path),
    request,
  };
})();