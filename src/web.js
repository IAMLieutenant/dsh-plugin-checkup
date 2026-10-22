/**
 * Read-only web surface: one HTML page + one JSON endpoint.
 *
 * Security posture (same as the memory plugin's proven pattern):
 *   - loopback + same-origin only (`localRequest`)
 *   - no-store, nosniff, no-referrer, same-origin resource policy
 *   - HTML served with a per-request nonce CSP
 *   - GET only; the plugin never writes anywhere
 */

import { randomBytes } from 'node:crypto';
import { renderPage } from './page.js';
import { toMarkdown } from './report.js';

const PAGE_ROUTE = '/_dsh/plugin-checkup';
const API_ROUTE = '/_dsh/plugin-checkup/api';

/** @param {import('node:http').IncomingMessage} req */
function localRequest(req) {
  const remote = req.socket?.remoteAddress;
  if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  let url;
  try {
    url = new URL(`http://${req.headers.host}`);
  } catch {
    return false;
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== url.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {unknown} body
 * @param {{html?: boolean, nonce?: string}} [options]
 */
function send(res, code, body, options = {}) {
  const html = options.html === true;
  const csp = html
    ? `default-src 'none'; script-src 'nonce-${options.nonce}'; style-src 'nonce-${options.nonce}'; ` +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
    : "default-src 'none'; frame-ancestors 'none'";
  res.writeHead(code, {
    'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': csp,
  });
  res.end(html ? String(body) : JSON.stringify(body));
}

/**
 * @param {any} ctx
 * @param {(force: boolean) => Promise<any>} getReport
 * @param {{ saveBaseline: () => Promise<any>, clearBaseline: () => Promise<void> }} baselineActions
 */
export function installCheckupWeb(ctx, getReport, baselineActions) {
  const token = randomBytes(32).toString('hex');

  ctx.inject(['webServer'], (child) => {
    const web = child.get('webServer');
    if (!web?.register) return;

    child.effect(() =>
      web.register({
        kind: 'exact',
        path: PAGE_ROUTE,
        handler: async (req, res) => {
          if (!localRequest(req)) return send(res, 403, { ok: false, error: '仅允许本机同源访问' });
          if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, error: '需要 GET' });
          const nonce = randomBytes(20).toString('hex');
          const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
          const embedded = params.get('embedded') === '1';
          send(res, 200, renderPage({ nonce, embedded, token }), { html: true, nonce });
        },
      }),
    );

    child.effect(() =>
      web.register({
        kind: 'exact',
        path: `${API_ROUTE}/baseline`,
        handler: async (req, res) => {
          if (!localRequest(req)) return send(res, 403, { ok: false, error: '仅允许本机同源访问' });
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '需要 POST' });
          if (req.headers['x-checkup-token'] !== token) return send(res, 403, { ok: false, error: '令牌校验失败，请刷新页面' });
          if (String(req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') {
            return send(res, 415, { ok: false, error: '需要 JSON 请求体' });
          }
          let body = '';
          try {
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 1024 * 1024) throw new Error('请求体过大');
            }
          } catch (error) {
            return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          let action = '';
          try {
            action = JSON.parse(body || '{}')?.action ?? '';
          } catch {
            return send(res, 400, { ok: false, error: 'JSON 解析失败' });
          }
          try {
            if (action === 'save') {
              const snapshot = await baselineActions.saveBaseline();
              return send(res, 200, { ok: true, baseline: { recordedAt: snapshot.recordedAt } });
            }
            if (action === 'clear') {
              await baselineActions.clearBaseline();
              return send(res, 200, { ok: true });
            }
            return send(res, 400, { ok: false, error: '未知动作' });
          } catch (error) {
            return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );

    child.effect(() =>
      web.register({
        kind: 'exact',
        path: API_ROUTE,
        handler: async (req, res) => {
          if (!localRequest(req)) return send(res, 403, { ok: false, error: '仅允许本机同源访问' });
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '需要 GET' });
          try {
            const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
            const report = await getReport(params.get('refresh') === '1');
            if (params.get('format') === 'md') {
              const markdown = toMarkdown(report);
              res.writeHead(200, {
                'Content-Type': 'text/markdown; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
              });
              res.end(markdown);
              return;
            }
            send(res, 200, { ok: true, report });
          } catch (error) {
            send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );
  });
}

export { PAGE_ROUTE, API_ROUTE };
