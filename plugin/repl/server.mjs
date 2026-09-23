#!/usr/bin/env node
/**
 * browser-repl: batched, typed browser actions over an existing CDP connection.
 *
 * This exists to close the round-trip gap with single-`repl` agents like Aside,
 * where one 120-second call can snapshot, decide, act and verify. Granular MCP
 * tools are safer but chatty: a Google Calendar out-of-office event took ~15
 * separate tool calls, most of them re-reading a page that had barely changed.
 *
 * Two ideas do most of the work:
 *
 *   1. `snapshot` returns a DIFF. Measured on Google Calendar: the full tree is
 *      ~5.5KB, and the diff after opening a menu is 190 bytes. A follow-up call
 *      should not have to re-read the whole page to learn that four menu items
 *      appeared.
 *
 *   2. `act` takes a LIST of typed steps and runs them in one call, stopping at
 *      the first failure and returning the diff afterwards.
 *
 * What it deliberately does not do is evaluate arbitrary script. `op` is a
 * closed enum, so nothing here can express "run this JavaScript". That is the
 * whole difference from a REPL: the efficiency without the capability that
 * leaves half-completed forms behind.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright-core';
import { collect } from './snapshot.mjs';
import { resolveTarget, isWrite, renderResponse } from './fetch.mjs';
import { pickNote, renderNote } from './siteskill.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Any Chromium exposing a CDP port: Chromium, Chrome, Brave, Edge. Nothing
// here is Brave-specific. The BRAVE_ names still work so an already-configured
// machine keeps running.
const CDP =
  process.env.AGENT_CDP_ENDPOINT || process.env.BRAVE_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const CONNECT_TIMEOUT_MS =
  Number(process.env.AGENT_CDP_TIMEOUT_MS || process.env.BRAVE_CDP_TIMEOUT_MS) || 120_000;

/**
 * Where the hand-written site notes live. Same resolution as the memory
 * server: the agent's cwd is its workspace, so the default needs no config.
 */
const SITES = join(
  process.env.AGENT_MEMORY_DIR ||
    (process.env.AGENT_WORKSPACE ? join(process.env.AGENT_WORKSPACE, 'memory') : join(process.cwd(), 'memory')),
  'sites',
);

/**
 * Hosts whose note has already been sent this session.
 *
 * Injected once, not on every navigation. The note does not change while the
 * agent works, and re-sending 4KB each time it moves between Slack channels
 * would cost more than the mistake it prevents - the same reasoning that makes
 * `snapshot` return a diff.
 */
const noteSent = new Set();

/** The site note for a url, or null. Never throws: no notes is a normal state. */
async function siteNoteFor(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host || noteSent.has(host)) return null;
  try {
    const file = pickNote(host, await readdir(SITES));
    if (!file) return null;
    noteSent.add(host);
    return renderNote({ path: `sites/${file}`, text: await readFile(join(SITES, file), 'utf8') });
  } catch {
    return null;
  }
}

let browser = null;
/** Last serialised snapshot per page URL, so `diff` has something to compare. */
const lastSerial = new Map();

async function connect() {
  if (browser && browser.isConnected()) return browser;
  // Playwright's default connect timeout is 30s, and it attaches to every
  // target on the way in. That is ample for a headless test browser and not
  // ample for a real one: a signed-in profile with a couple of dozen tabs and
  // extension background pages timed out every time, reporting only
  // "Timeout 30000ms exceeded" with no hint that the browser was fine.
  browser = await chromium.connectOverCDP(CDP, { timeout: CONNECT_TIMEOUT_MS });
  return browser;
}

function allPages(b) {
  return b.contexts().flatMap((c) => c.pages());
}

/**
 * Resolve which page to act on. Defaults to the last one snapshotted, then to
 * whichever is frontmost, because an agent almost always means "the page I was
 * just looking at" rather than "page 0".
 */
async function resolvePage(b, match) {
  const pages = allPages(b);
  if (!pages.length) throw new Error('No pages open in the browser.');
  if (match === undefined || match === null || match === '') {
    return pages.find((p) => lastSerial.has(p.url())) || pages[0];
  }
  if (typeof match === 'number') {
    if (!pages[match]) throw new Error(`No page at index ${match}; ${pages.length} open.`);
    return pages[match];
  }
  const needle = String(match).toLowerCase();
  const hit = pages.find(
    (p) => p.url().toLowerCase().includes(needle) || (p._brTitle || '').toLowerCase().includes(needle),
  );
  if (hit) return hit;
  for (const p of pages) {
    const t = (await p.title().catch(() => '')).toLowerCase();
    if (t.includes(needle)) return p;
  }
  throw new Error(`No open page matching ${JSON.stringify(match)}.`);
}

function locate(page, ref) {
  if (!/^e\d+$/.test(String(ref))) {
    throw new Error(`Bad ref ${JSON.stringify(ref)}. Refs look like "e42" and come from snapshot.`);
  }
  return page.locator(`[data-bref="${ref}"]`);
}

/**
 * Click, preferring real input.
 *
 * Playwright's actionability gate requires the bounding box to be unchanged
 * across two consecutive animation frames, which continuously animating pages
 * never satisfy. Google Calendar refuses every time while being perfectly
 * clickable. So: try a real click briefly, and fall back to a DOM click rather
 * than failing. Report which path ran, because a DOM click bypasses handlers a
 * real one would trigger and that occasionally matters.
 */
async function clickSmart(page, ref) {
  const loc = locate(page, ref);
  try {
    await loc.click({ timeout: 2500 });
    return 'input';
  } catch (err) {
    if (!/stable|visible|enabled|timeout/i.test(err.message)) throw err;
    await loc.evaluate((el) => el.click());
    return 'dom';
  }
}

async function runStep(page, step, i) {
  const op = step.op;
  switch (op) {
    case 'click':
      return { i, op, ref: step.ref, via: await clickSmart(page, step.ref) };
    case 'type': {
      const loc = locate(page, step.ref);
      await loc.evaluate((el) => el.focus());
      if (step.clear) await page.keyboard.press('ControlOrMeta+A').catch(() => {});
      await page.keyboard.type(String(step.text ?? ''), { delay: step.delay ?? 20 });
      return { i, op, ref: step.ref, typed: String(step.text ?? '').length };
    }
    case 'press':
      await page.keyboard.press(String(step.key));
      return { i, op, key: step.key };
    case 'navigate':
      await page.goto(String(step.url), { waitUntil: 'domcontentloaded' });
      return { i, op, url: step.url };
    case 'select': {
      const loc = locate(page, step.ref);
      const picked = await loc.selectOption(String(step.value));
      return { i, op, ref: step.ref, picked };
    }
    case 'wait':
      if (step.forText) {
        await page.getByText(String(step.forText)).first().waitFor({ timeout: step.timeout ?? 10000 });
        return { i, op, forText: step.forText };
      }
      await page.waitForTimeout(Math.min(step.ms ?? 500, 15000));
      return { i, op, ms: step.ms ?? 500 };
    case 'screenshot': {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      return { i, op, screenshot: buf.toString('base64'), bytes: buf.length };
    }
    default:
      throw new Error(
        `Unknown op ${JSON.stringify(op)}. Allowed: click, type, press, navigate, select, wait, screenshot. ` +
          `There is deliberately no op for running arbitrary script.`,
      );
  }
}

async function snapshotPage(page, mode, options = {}) {
  const prev = mode === 'diff' ? lastSerial.get(page.url()) ?? null : null;
  const r = await page.evaluate(collect, { prevSerial: prev, options });
  // A scoped or filtered read is a partial view of the page, so it must not
  // become the baseline a later diff is measured against - that would report
  // the rest of the page as having appeared.
  if (!options.ref && !options.interactive) lastSerial.set(r.url, r.serial);
  page._brTitle = r.title;
  return r;
}

function renderSnapshot(r, mode) {
  if (r.missingRef) {
    return `Ref ${r.missingRef} is gone: the page has been snapshotted again since, or it has changed. Take a full snapshot and scope to a current ref.`;
  }
  const notes = [
    r.scoped ? `scoped to ${r.scoped}` : null,
    r.interactive ? 'interactive (clickable / focusable) elements only' : null,
  ].filter(Boolean);
  const head =
    `${r.title}\n${r.url}\n${r.count} refs` +
    (notes.length ? `\nnote: ${notes.join(', ')}` : '');
  if (mode === 'diff' && r.diff) {
    const { added, removed, unchanged } = r.diff;
    if (!added.length && !removed.length) return `${head}\n\nNo change since the last snapshot.`;
    return (
      `${head}\n\nDIFF  +${added.length} -${removed.length}  (${unchanged} unchanged)\n` +
      (added.length ? `\nAPPEARED\n${added.join('\n')}\n` : '') +
      (removed.length ? `\nGONE\n${removed.join('\n')}\n` : '')
    );
  }
  return `${head}\n\n${r.serial}`;
}

const TOOLS = [
  {
    name: 'snapshot',
    description:
      'Accessibility tree of a page with stable [ref=eNN] ids. mode "diff" returns only what appeared and disappeared since your last snapshot of that page, which is usually a fraction of the size, measured at 190 bytes against a 5.5KB full tree. Use diff for every read after the first. `ref` narrows to one subtree and `interactive` drops everything you cannot act on; unlike diff they both work on a first read, which is what you want after opening a menu or a dialog. These refs work only with this server; mcp__browser__ and mcp__devtools__ each use their own.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: ['string', 'number'], description: 'URL substring, title substring, or index. Defaults to the page you last snapshotted.' },
        mode: { type: 'string', enum: ['full', 'diff'], default: 'full' },
        ref: { type: 'string', description: 'Return only the subtree under this ref, e.g. "e276". For reading a menu, dialog or result list you just opened without paying for the page around it. The ref must come from your most recent snapshot of this page.' },
        interactive: { type: 'boolean', description: 'Keep only what can be clicked, typed into or focused, dropping headings, images and layout containers. Pair with ref to read a panel you are about to act in.' },
      },
    },
  },
  {
    name: 'act',
    description:
      'Run several typed browser steps in ONE call, then return the snapshot diff. Worth using only when the steps are INDEPENDENT of each other: filling six known form fields then submitting, or a fixed navigate-wait-screenshot sequence. It does NOT help when a step needs a ref you can only learn from the previous step\'s result, which is most browser work. Measured on a real task, batching saved zero turns because the menu had to open before its items could be referenced. Steps stop at the first failure by default and report which one failed with the page state at that moment. Clicks try real input first and fall back to a DOM click when Playwright\'s stability gate refuses, which it always does on continuously animating pages.',
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        page: { type: ['string', 'number'] },
        stopOnError: { type: 'boolean', default: true },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['op'],
            properties: {
              op: { type: 'string', enum: ['click', 'type', 'press', 'navigate', 'select', 'wait', 'screenshot'] },
              ref: { type: 'string', description: 'From snapshot, e.g. "e42"' },
              text: { type: 'string' },
              clear: { type: 'boolean', description: 'Select-all before typing' },
              key: { type: 'string', description: 'e.g. "Enter", "Escape", "ControlOrMeta+A"' },
              url: { type: 'string' },
              value: { type: 'string' },
              forText: { type: 'string', description: 'wait until this text is visible' },
              ms: { type: 'number' },
              timeout: { type: 'number' },
              delay: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: 'pages',
    description: 'List open tabs with index, title and URL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fetch',
    description:
      'Call a site\'s own API from inside a tab already signed in to it, and get the response back. The request runs in the page, so it carries that session\'s cookies and needs no token. Use it whenever the site has an endpoint for what you want: reading a mailbox, a doc or a calendar this way is one call instead of the dozen a DOM walk takes, and it does not disturb what is on screen. SAME-ORIGIN ONLY - open a tab on the site first, then fetch its paths. Writes (POST, PUT, PATCH, DELETE) act as the user, immediately and for real; there is no draft step and no undo, so be as sure as you would be before clicking Send.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Path or absolute url. Must be the same origin as the page.' },
        page: { type: ['string', 'number'], description: 'Which tab supplies the session. Defaults to the page you last snapshotted.' },
        method: { type: 'string', default: 'GET', description: 'GET, POST, PUT, PATCH, DELETE, HEAD' },
        headers: { type: 'object', description: 'Extra request headers. Content-Type is set for you when body is an object.' },
        body: { type: ['string', 'object'], description: 'String sent as-is; object is JSON-encoded.' },
        maxChars: { type: 'number', default: 12000, description: 'Truncate the response body at this many characters.' },
      },
    },
  },
];

const server = new Server({ name: 'browser-repl', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/**
 * How much a result costs to read, and how long it took to get.
 *
 * Aside puts `tokens_used` and `elapsed_time` on every tool result, and the
 * effect is a model that can see which of its reads are expensive and shift to
 * the cheaper ones. Characters/4 is the usual rough token estimate; it is an
 * estimate and says so, since the real count depends on the tokeniser.
 */
function withCost(result, startedAt) {
  const text = (result?.content || []).map((c) => c.text || '').join('');
  const approx = Math.ceil(text.length / 4);
  return {
    ...result,
    content: [
      ...(result.content || []),
      { type: 'text', text: `\n[~${approx} tokens, ${Date.now() - startedAt}ms]` },
    ],
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const startedAt = Date.now();
  try {
    const b = await connect();

    if (name === 'pages') {
      const pages = allPages(b);
      const rows = await Promise.all(
        pages.map(async (p, i) => `${i}: ${await p.title().catch(() => '?')} | ${p.url()}`),
      );
      return withCost({ content: [{ type: 'text', text: rows.join('\n') }] }, startedAt);
    }

    if (name === 'snapshot') {
      const page = await resolvePage(b, args.page);
      const mode = args.mode || 'full';
      const r = await snapshotPage(page, mode, { ref: args.ref, interactive: args.interactive });
      return withCost({ content: [{ type: 'text', text: renderSnapshot(r, mode) }], isError: Boolean(r.missingRef) }, startedAt);
    }

    if (name === 'fetch') {
      const page = await resolvePage(b, args.page);
      const { url } = resolveTarget(page.url(), args.url);
      const method = String(args.method || 'GET').toUpperCase();

      // The request is issued by the page, not by node, which is the entire
      // point: node has no session, and the page has the one the user signed
      // in with. credentials:'same-origin' is the default for same-origin, but
      // saying it makes the intent unmissable to anyone reading this later.
      const res = await page.evaluate(
        async ({ url, method, headers, body }) => {
          try {
            const init = { method, credentials: 'same-origin', headers: { ...(headers || {}) } };
            if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
              if (typeof body === 'string') {
                init.body = body;
              } else {
                init.body = JSON.stringify(body);
                if (!Object.keys(init.headers).some((h) => h.toLowerCase() === 'content-type')) {
                  init.headers['Content-Type'] = 'application/json';
                }
              }
            }
            const r = await fetch(url, init);
            const headersOut = {};
            r.headers.forEach((v, k) => { headersOut[k] = v; });
            return { status: r.status, statusText: r.statusText, url: r.url, headers: headersOut, body: await r.text() };
          } catch (err) {
            return { error: String(err && err.message ? err.message : err) };
          }
        },
        { url, method, headers: args.headers, body: args.body },
      );

      const text = renderResponse(res, { maxChars: args.maxChars ?? 12000 });
      // A write that came back 4xx/5xx is the case most worth not glossing:
      // the agent should see it failed rather than read a body and move on.
      const bad = Boolean(res?.error) || (typeof res?.status === 'number' && res.status >= 400);
      return withCost({
        content: [{ type: 'text', text: isWrite(method) ? `${method} ${url}\n${text}` : text }],
        isError: bad,
      }, startedAt);
    }

    if (name === 'act') {
      const page = await resolvePage(b, args.page);
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (!steps.length) throw new Error('act needs at least one step.');
      const stopOnError = args.stopOnError !== false;

      const results = [];
      const shots = [];
      let failed = null;

      for (let i = 0; i < steps.length; i++) {
        try {
          const r = await runStep(page, steps[i], i);
          if (r.screenshot) {
            shots.push(r.screenshot);
            delete r.screenshot;
          }
          results.push(r);
        } catch (err) {
          failed = { i, op: steps[i]?.op, error: err.message.split('\n')[0] };
          results.push({ i, op: steps[i]?.op, error: failed.error });
          if (stopOnError) break;
        }
      }

      // Always report state afterwards. A step that "succeeded" is not evidence
      // the app accepted it, and this is the cheapest way to check.
      const snap = await snapshotPage(page, 'diff');
      const lines = [
        `${results.length}/${steps.length} steps run` + (failed ? `, FAILED at step ${failed.i} (${failed.op}): ${failed.error}` : ''),
        results.map((r) => `  ${r.i} ${r.op}${r.via ? ` via ${r.via}` : ''}${r.error ? ` ERROR ${r.error}` : ' ok'}`).join('\n'),
        '',
        renderSnapshot(snap, 'diff'),
      ];
      // Arriving somewhere is when a site note is worth having, not later when
      // the agent has already typed into the composer the note warns about.
      const note = results.some((r) => r.op === 'navigate' && !r.error)
        ? await siteNoteFor(page.url())
        : null;
      if (note) lines.push('', note);

      const content = [{ type: 'text', text: lines.join('\n') }];
      for (const s of shots) content.push({ type: 'image', data: s, mimeType: 'image/jpeg' });
      return withCost({ content, isError: Boolean(failed) }, startedAt);
    }

    throw new Error(`Unknown tool ${name}`);
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
