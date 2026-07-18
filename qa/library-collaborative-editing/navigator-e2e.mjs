#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  CdpConnection,
  captureScreenshot,
  clickByText,
  clickSelector,
  evaluate,
  fetchVersion,
  fillByLabel,
  listTargets,
  snapshotPage,
  waitForSelector,
  waitForText,
} from '../../controller/lib/cdp-client.mjs';

const QA_ROOT = path.resolve(import.meta.dirname);
const DEFAULT_LIBRARY_ORIGIN = 'http://127.0.0.1:3010';
const DEFAULT_ADMIN_ORIGIN = 'http://127.0.0.1:3002';
const DEFAULT_ADA_ORIGIN = 'http://127.0.0.1:3020';
const DEFAULT_SLUG = 'lovelaces-square/what-is-lovelace';
const DEFAULT_SUMMARY = 'Agent Navigator collaborative editing QA';
const DEFAULT_ATTRIBUTION = 'Agent Navigator QA';
const DEFAULT_REVIEW_NOTE = 'Please clarify the final sentence for this QA review.';
const DEFAULT_ARTIFACT_REVIEW_NOTE = 'Please add the reviewed correction marker and clarify the artifact fallback.';
const DEFAULT_LIVE_REASON = 'Agent Navigator isolated-local live-delivery verification.';
const DEFAULT_PROBE = 'Navigator live delivery QA';
const QA_REVIEW_COMMENT = 'Agent Navigator reviewer comment.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOWER_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const LOWER_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BLOCK_ID_PATTERN = /^lsb_[0-9a-f]{32}$/;
const CURRENT_EDITOR_CONTRACT = 'library-content-editor-v5';
const AUTHENTICATED_EDITOR_ACTION = 'Suggest an edit';
const EDITOR_ACTION_STABILITY_MS = 750;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [key, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function option(flags, key, fallback) {
  const value = flags[key];
  return value === undefined ? fallback : String(value);
}

function numberOption(flags, key, fallback) {
  const parsed = Number(option(flags, key, fallback));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid --${key}: ${parsed}`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function js(value) {
  return JSON.stringify(value);
}

function safeEvidenceName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function safeSameOriginPath(value) {
  assert(
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value),
    'The local-login destination must be a safe same-origin path.',
  );
  const base = new URL('http://agent-navigator.invalid');
  const parsed = new URL(value, base);
  assert(parsed.origin === base.origin, 'The local-login destination changed origin.');
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function loopbackOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute loopback HTTP origin.`);
  }
  assert(parsed.protocol === 'http:', `${label} must use HTTP inside the disposable local stack.`);
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname),
    `${label} must use an exact loopback hostname.`,
  );
  assert(parsed.username === '' && parsed.password === '', `${label} must not contain credentials.`);
  assert(parsed.pathname === '/' && parsed.search === '' && parsed.hash === '', `${label} must be an origin without a path, query, or fragment.`);
  return parsed.origin;
}

function privateEvidenceDirectory(value) {
  const root = path.resolve(os.homedir(), '.lovelace', 'qa-evidence');
  const resolved = path.resolve(value);
  const relative = path.relative(root, resolved);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Evidence must be a private child of ${root}.`);
  return resolved;
}

function usage() {
  console.log(`Agent Navigator checks for Library collaborative editing

Usage:
  node qa/library-collaborative-editing/navigator-e2e.mjs <command> [options]

Commands:
  self-test                  Run contract/origin checks without opening a browser.
  preflight                  Validate the Agent Navigator CDP primitives.
  local-login                Authenticate the current private profile through Admin's local tester.
  editor-auth-smoke          Open the editor through the guarded authenticated action without writing.
  signed-out                Assert the Google account affordance, hidden edit controls, and 401 API boundary.
  expect-manifest-error     Assert a configured manifest status/code denial.
  role-denied               Assert an authenticated but ineligible account is denied.
  withdraw-open-draft       Withdraw an exact QA draft after an interrupted harness run.
  contributor-stage        Validate Markdown/typed editing and stage a safe artifact on one draft.
  artifact-approve         Independently approve the exact static rendition in Admin.
  artifact-request-changes Independently request exact changes to the submitted artifact.
  contributor-revise-artifact Reload the reviewed source, create, and submit one exact child.
  artifact-approve-child   Independently approve the exact submitted child rendition.
  contributor-submit      Refresh the artifact receipt and submit the combined proposal.
  contributor-submit-corrected Require the approved child before combined proposal submission.
  admin-self-review         Assert a contributor cannot review their own proposal.
  admin-request-changes     Review the dossier, comment, and request changes.
  contributor-feedback     Assert feedback and contributor metadata are restored.
  stale-concurrency         Race two same-session tabs and require a stale-workflow error.
  contributor-resubmit     Reload the winning draft and resubmit with terms.
  admin-activate           Independently activate the trusted render receipt and wake delivery.
  public-convergence       Verify dynamic HTML/Markdown/catalog/search/LLM/manifest convergence.
  admin-convergence        Verify all ten delivery surfaces, including Ada, in Admin.
  retry-delivery           Retry an intentionally failed/retry-wait local delivery job.
  rollback                 Publish an append-only rollback and verify a higher generation.
  security-boundaries      Assert worker auth, raw HTML and executable artifact boundaries.
  mobile                    Assert a responsive viewport and capture a screenshot.
  close-browser             Close only the Brave instance on the selected CDP port.

Common options:
  --port <n>                CDP port (required by convention; default 9333).
  --library <origin>        Library origin (default http://127.0.0.1:3010).
  --admin <origin>          Admin origin (default http://127.0.0.1:3002).
  --ada <origin>            Ada origin (default http://127.0.0.1:3020).
  --slug <path>             Article slug.
  --evidence <directory>    Private screenshot directory.
  --summary <text>          Stable proposal summary shared across phases.
  --probe <text>            Unique plain-text marker used for convergence and rollback.
  --artifact-review-note <text> Exact artifact feedback shared across correction phases.
  --live-reason <text>      Exact activation/retry/rollback audit reason.
  --profile-label <text>    Non-secret label used for local-login evidence.
  --login-destination <path> Safe local-login destination (default /review/library-edits).
`);
}

async function connectTarget(target) {
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  await connection.send('Page.enable');
  await connection.send('Runtime.enable');
  await connection.send('Page.bringToFront');
  return connection;
}

async function primarySession(port) {
  const targets = (await listTargets({ port }))
    .filter((target) => target.type === 'page')
    .filter((target) => !String(target.url || '').startsWith('chrome-extension://'));
  assert(targets.length > 0, `No browser page is available on CDP port ${port}.`);
  return { target: targets[0], connection: await connectTarget(targets[0]) };
}

async function waitUntil(connection, expression, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(connection, expression);
      if (lastValue) return lastValue;
    } catch (error) {
      // A real document navigation can briefly invalidate the prior execution
      // context. Keep polling the new context, but retain the diagnostic if the
      // condition never settles.
      lastValue = { evaluationError: error instanceof Error ? error.message : String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`${message} (last value: ${JSON.stringify(lastValue)})`);
}

function documentUrl(value) {
  const parsed = new URL(value);
  parsed.hash = '';
  return parsed.href;
}

async function navigateNewDocument(connection, url, expectedDocumentUrl = null) {
  const previousTimeOrigin = await evaluate(connection, 'performance.timeOrigin');
  const navigation = await connection.send('Page.navigate', { url });
  assert(!navigation.errorText, `Navigation failed for ${url}: ${navigation.errorText}`);
  assert(navigation.loaderId && !navigation.isDownload, `Navigation did not create a new document loader: ${url}`);
  await waitUntil(
    connection,
    `(() => {
      const current = new URL(location.href);
      current.hash = '';
      return document.readyState === 'complete' &&
        performance.timeOrigin !== ${js(previousTimeOrigin)} &&
        (${expectedDocumentUrl === null ? 'true' : `current.href === ${js(expectedDocumentUrl)}`});
    })()`,
    `Navigation did not finish: ${url}`,
    30_000,
  );
}

async function navigate(connection, url) {
  await navigateNewDocument(connection, url, documentUrl(url));
}

async function reload(connection) {
  const previousDocument = await evaluate(connection, `({
    href: (() => { const current = new URL(location.href); current.hash = ''; return current.href; })(),
    timeOrigin: performance.timeOrigin,
  })`);
  assert(previousDocument?.href && Number.isFinite(previousDocument.timeOrigin), 'Could not capture the document receipt before reload.');
  await connection.send('Page.reload', { ignoreCache: true });
  await waitUntil(
    connection,
    `(() => {
      const current = new URL(location.href);
      current.hash = '';
      return document.readyState === 'complete' && current.href === ${js(previousDocument.href)} && performance.timeOrigin !== ${js(previousDocument.timeOrigin)};
    })()`,
    'Page reload did not finish.',
    30_000,
  );
}

async function dismissOptionalCookieBanner(connection) {
  const inspect = `(() => {
    const rendered = (element) => {
      if (!element?.isConnected) return false;
      if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    };
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter((candidate) => (candidate.textContent || '').trim() === 'Decline')
      .filter(rendered);
    if (buttons.length === 0) return { state: 'absent' };
    for (const button of buttons) {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === button || button.contains(hit))) {
        return { state: 'actionable', x, y, hitTag: hit.tagName.toLowerCase() };
      }
    }
    return { state: 'blocked', count: buttons.length };
  })()`;
  let result = await evaluate(connection, inspect);
  if (result?.state === 'absent') return false;
  const deadline = Date.now() + 5_000;
  while (result?.state !== 'actionable' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 125));
    result = await evaluate(connection, inspect);
    if (result?.state === 'absent') return false;
  }
  assert(result?.state === 'actionable', `The analytics Decline button never became a real hit target: ${JSON.stringify(result)}.`);
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: result.x, y: result.y });
  await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: result.x, y: result.y, button: 'left', clickCount: 1 });
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: result.x, y: result.y, button: 'left', clickCount: 1 });
  await waitUntil(
    connection,
    `!Array.from(document.querySelectorAll('button')).some((button) => {
      if ((button.textContent || '').trim() !== 'Decline') return false;
      if (typeof button.checkVisibility === 'function') return button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    })`,
    'The optional analytics banner did not close.',
  );
  return true;
}

async function strictClickText(connection, text) {
  if (text !== 'Decline') await dismissOptionalCookieBanner(connection);
  // The stock helper calls click() and then reads the same node. React can
  // replace that node synchronously, which makes Chromium fail serialization
  // with "Object reference chain is too long" even though the click happened.
  // Capture only screen coordinates, then send a real CDP mouse sequence so
  // every application action remains browser-driven without serializing a
  // React mutation from inside Runtime.evaluate.
  const deadline = Date.now() + 15_000;
  let result;
  while (Date.now() < deadline) {
    result = await evaluate(connection, `(() => {
      const normalize = (value) => String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ');
      const expected = normalize(${js(text)});
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const match = Array.from(document.querySelectorAll('button,a,input[type="button"],input[type="submit"],[role="button"]'))
        .filter(visible)
        .find((element) => {
          const values = [element.innerText || element.textContent || '', element.getAttribute('aria-label') || '', element.getAttribute('value') || '', element.getAttribute('title') || '']
            .map(normalize)
            .filter(Boolean);
          return values.some((value) => value === expected || value.includes(expected));
        });
      if (!match) return { ok: false, error: 'not-found' };
      if (match.disabled || match.matches(':disabled') || match.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'disabled' };
      match.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = match.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || (hit !== match && !match.contains(hit))) {
        return { ok: false, error: 'occluded', hitTag: hit?.tagName?.toLowerCase() || null };
      }
      return { ok: true, tag: match.tagName.toLowerCase(), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (result?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  assert(result?.ok === true, `Agent Navigator could not click text: ${text}${result?.error ? ` (${result.error}${result.hitTag ? ` by ${result.hitTag}` : ''})` : ''}`);
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: result.x, y: result.y });
  await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: result.x, y: result.y, button: 'left', clickCount: 1 });
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: result.x, y: result.y, button: 'left', clickCount: 1 });
  return result;
}

async function strictClickSelector(connection, selector) {
  await dismissOptionalCookieBanner(connection);
  const deadline = Date.now() + 15_000;
  let result;
  while (Date.now() < deadline) {
    result = await evaluate(connection, `(() => {
      const element = document.querySelector(${js(selector)});
      if (!element) return { ok: false, error: 'not-found' };
      if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return { ok: false, error: 'not-visible' };
      }
      const style = getComputedStyle(element);
      const initialRect = element.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) <= 0 || initialRect.width <= 0 || initialRect.height <= 0) return { ok: false, error: 'not-visible' };
      if (element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'disabled' };
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const placements = [0.5, 0.25, 0.75, 0.125, 0.875];
      let lastHit = null;
      for (const placement of placements) {
        let rect = element.getBoundingClientRect();
        if (placement !== 0.5) {
          const desiredY = innerHeight * placement;
          window.scrollBy({ top: (rect.top + rect.height / 2) - desiredY, behavior: 'instant' });
          rect = element.getBoundingClientRect();
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        lastHit = hit;
        if (hit && (hit === element || element.contains(hit))) {
          return { ok: true, x, y, placement };
        }
      }
      return { ok: false, error: 'occluded-at-all-placements', hitTag: lastHit?.tagName?.toLowerCase() || null };
    })()`);
    if (result?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  assert(result?.ok === true, `Agent Navigator could not click selector: ${selector}${result?.error ? ` (${result.error}${result.hitTag ? ` by ${result.hitTag}` : ''})` : ''}`);
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: result.x, y: result.y });
  await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: result.x, y: result.y, button: 'left', clickCount: 1 });
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: result.x, y: result.y, button: 'left', clickCount: 1 });
  return result;
}

async function buttonState(connection, text) {
  return evaluate(connection, `(() => {
    const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\\s+/g, ' ');
    const expected = normalize(${js(text)});
    const button = Array.from(document.querySelectorAll('button,a,[role="button"]'))
      .filter((item) => {
        if (typeof item.checkVisibility === 'function') return item.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        const style = getComputedStyle(item);
        const rect = item.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      })
      .find((item) => normalize(item.innerText || item.textContent || item.getAttribute('aria-label')) === expected);
    return button ? { found: true, disabled: Boolean(button.disabled || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true'), title: button.getAttribute('title') || '' } : { found: false };
  })()`);
}

async function assertButton(connection, text, disabled) {
  if (disabled !== undefined) return waitForButtonState(connection, text, disabled);
  const deadline = Date.now() + 15_000;
  let state = null;
  while (Date.now() < deadline) {
    state = await buttonState(connection, text);
    if (state.found) return state;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Button was not found after rendering settled: ${text} (last state: ${JSON.stringify(state)}).`);
}

async function waitForButtonState(connection, text, disabled, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await buttonState(connection, text);
    if (state.found && state.disabled === disabled) return state;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`${text} did not settle to disabled=${disabled} (last state: ${JSON.stringify(state)}).`);
}

async function focusSelector(connection, selector) {
  const focused = await evaluate(connection, `(() => {
    const element = document.querySelector(${js(selector)});
    if (!element) return false;
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    element.focus();
    return document.activeElement === element;
  })()`);
  assert(focused, `Could not focus selector: ${selector}`);
}

async function pressKey(connection, key, options = {}) {
  const mapping = {
    Enter: { code: 'Enter', keyCode: 13 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    a: { code: 'KeyA', keyCode: 65 },
  };
  const mapped = mapping[key] || { code: key, keyCode: 0 };
  const modifiers = options.control ? 2 : 0;
  // Chromium performs a native button's Enter activation only when CDP sends
  // the text-producing keyDown form. A rawKeyDown still emits trusted
  // keydown/keyup events, but it omits keypress/default activation and can
  // falsely report a keyboard accessibility failure.
  const text = key === 'Enter' && modifiers === 0 ? '\r' : undefined;
  await connection.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    nativeVirtualKeyCode: mapped.keyCode,
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await connection.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: mapped.code, windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode, modifiers,
  });
}

async function fillNative(connection, selector, value) {
  await focusSelector(connection, selector);
  await pressKey(connection, 'a', { control: true });
  await pressKey(connection, 'Backspace');
  if (value) await connection.send('Input.insertText', { text: value });
  await waitUntil(
    connection,
    `document.querySelector(${js(selector)})?.value === ${js(value)}`,
    `Field did not receive the expected value: ${selector}`,
  );
}

async function setDialogCheckbox(connection, index, checked) {
  const result = await evaluate(connection, `(() => {
    const elements = document.querySelectorAll('aside[role="dialog"] input[type="checkbox"]');
    const element = elements[${index}];
    if (!(element instanceof HTMLInputElement)) return { ok: false, count: elements.length };
    if (element.checked !== ${checked ? 'true' : 'false'}) element.click();
    return { ok: true, checked: element.checked, disabled: element.disabled, count: elements.length };
  })()`);
  assert(result?.ok && result.checked === checked, `Dialog checkbox ${index} did not become ${checked}.`);
  return result;
}

async function screenshot(connection, evidenceDirectory, name) {
  await fs.mkdir(evidenceDirectory, { recursive: true });
  const stem = safeEvidenceName(name);
  let output;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = path.join(evidenceDirectory, `${stem}${suffix}.png`);
    try {
      await fs.access(candidate);
    } catch {
      output = candidate;
      break;
    }
  }
  assert(output, 'Could not allocate a unique screenshot path.');
  await captureScreenshot(connection, output);
  return output;
}

async function emitResult(context, result, discriminator = '') {
  await fs.mkdir(context.evidenceDirectory, { recursive: true });
  const recordedAt = new Date().toISOString();
  const parts = [
    safeEvidenceName(result.command || 'result'),
    context.profileLabel,
    safeEvidenceName(discriminator),
    recordedAt.replace(/[^0-9]/g, ''),
  ].filter(Boolean);
  const stem = parts.join('-');
  let receiptPath;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = path.join(context.evidenceDirectory, `${stem}${suffix}.json`);
    try {
      await fs.writeFile(candidate, `${JSON.stringify({
        schemaVersion: 1,
        recordedAt,
        profile: context.profileLabel,
        ...result,
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      receiptPath = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  assert(receiptPath, 'Could not allocate a unique Agent Navigator evidence receipt.');
  const output = { ...result, receipt: receiptPath };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

async function pageFetch(connection, url, init = {}) {
  const receipt = await evaluate(connection, `(async () => {
    const response = await fetch(${js(url)}, ${JSON.stringify({ ...init, credentials: 'same-origin', cache: 'no-store' })});
    const text = await response.text();
    return {
      status: response.status,
      bodyText: text,
      cacheControl: response.headers.get('cache-control'),
      releaseCommit: response.headers.get('x-library-release-commit'),
    };
  })()`);
  let body;
  try { body = JSON.parse(receipt.bodyText); } catch { body = receipt.bodyText.slice(0, 2000); }
  return { ...receipt, body };
}

function errorCode(response) {
  return response?.body?.error?.code ?? null;
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} is missing.`);
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} does not have the exact contract shape.`,
  );
}

function artifactFixtures(context) {
  const initialHtml = `<section><h2>${escapeHtml(context.artifactTitle)}</h2><p>${escapeHtml(context.probe)}</p></section>`;
  const correctionMarker = `${context.probe} reviewed artifact correction`;
  return {
    initial: {
      description: `Isolated QA artifact for ${context.probe}.`,
      provenance: 'Created from original static HTML solely for this disposable local QA run.',
      textFallback: `Static illustration demonstrating ${context.probe}.`,
      html: initialHtml,
    },
    corrected: {
      description: `Revised isolated QA artifact for ${context.probe}.`,
      provenance: `Revised from the exact independently reviewed source for ${context.probe}.`,
      textFallback: `Static illustration demonstrating ${context.probe}; revised after independent review.`,
      html: `<section><h2>${escapeHtml(context.artifactTitle)}</h2><p>${escapeHtml(context.probe)}</p><p>${escapeHtml(correctionMarker)}</p></section>`,
      marker: correctionMarker,
    },
  };
}

function artifactPlacementReceipt(value, label) {
  exactKeys(value, ['placementAnchorId', 'position', 'ordinal'], label);
  assert(/^lsp_[0-9a-f]{32}$/.test(value.placementAnchorId || ''), `${label} has an invalid placement anchor.`);
  assert(value.position === 'before' || value.position === 'after', `${label} has an invalid side.`);
  assert(Number.isSafeInteger(value.ordinal) && value.ordinal >= 0 && value.ordinal <= 100, `${label} has an invalid ordinal.`);
  return {
    placementAnchorId: value.placementAnchorId,
    position: value.position,
    ordinal: value.ordinal,
  };
}

function artifactReplacementReceipt(value, label) {
  if (value === null) return null;
  exactKeys(value, ['artifactId', 'artifactVersionId', 'version', 'renditionSha256'], label);
  assert(UUID_PATTERN.test(value.artifactId || '') && UUID_PATTERN.test(value.artifactVersionId || ''), `${label} has invalid IDs.`);
  assert(Number.isSafeInteger(value.version) && value.version > 0, `${label} has an invalid version.`);
  assert(LOWER_SHA256_PATTERN.test(value.renditionSha256 || ''), `${label} has an invalid rendition hash.`);
  return {
    artifactId: value.artifactId,
    artifactVersionId: value.artifactVersionId,
    version: value.version,
    renditionSha256: value.renditionSha256,
  };
}

function expectedCorrectionSourceAndMetadata(parent, fixture) {
  return {
    source: {
      title: parent.title,
      html: fixture.html,
      ...(parent.language ? { language: parent.language } : {}),
    },
    metadata: {
      description: fixture.description,
      licenceSpdx: parent.licenceSpdx,
      attribution: parent.attribution,
      sourceUrl: parent.sourceUrl,
      rightsHolder: parent.rightsHolder,
      provenance: fixture.provenance,
      thirdPartyAssetsDeclared: parent.thirdPartyAssetsDeclared,
      thirdPartyAssetNotes: parent.thirdPartyAssetNotes,
      accessibility: {
        ...parent.accessibility,
        textFallback: fixture.textFallback,
      },
    },
  };
}

function assertExactArtifactCorrectionRequest(request, expected) {
  exactKeys(request, [
    'articleId', 'baseReceipt', 'proposalId', 'expectedProposalWorkflowVersion',
    'placement', 'revision', 'source', 'metadata', 'termsAccepted',
    'rightsConfirmed', 'termsVersion', 'termsUrl',
  ], 'Artifact correction request');
  assert(request.articleId === expected.articleId, 'Artifact correction changed the article ID.');
  assert(request.proposalId === expected.proposalId, 'Artifact correction changed the proposal ID.');
  assert(request.expectedProposalWorkflowVersion === expected.proposalWorkflowVersion, 'Artifact correction did not use the exact proposal CAS version.');
  assertExactBaseReceipt(request.baseReceipt, expected.baseReceipt, 'Artifact correction base receipt');
  assert(
    JSON.stringify(artifactPlacementReceipt(request.placement, 'Artifact correction placement')) ===
      JSON.stringify(artifactPlacementReceipt(expected.parent.placement, 'Reviewed parent placement')),
    'Artifact correction changed the reviewed placement coordinate.',
  );
  exactKeys(request.revision, ['artifactId', 'parentVersionId', 'expectedArtifactLockVersion', 'replaces'], 'Artifact correction lineage');
  assert(request.revision.artifactId === expected.parent.artifactId, 'Artifact correction changed artifact identity.');
  assert(request.revision.parentVersionId === expected.parent.artifactVersionId, 'Artifact correction is not a child of the exact reviewed version.');
  assert(request.revision.expectedArtifactLockVersion === expected.parent.artifactLockVersion, 'Artifact correction did not use the exact reviewed artifact lock.');
  assert(
    JSON.stringify(artifactReplacementReceipt(request.revision.replaces, 'Artifact correction replacement')) ===
      JSON.stringify(artifactReplacementReceipt(expected.parent.replaces, 'Reviewed parent replacement')),
    'Artifact correction changed the reviewed replacement receipt.',
  );
  assert(JSON.stringify(request.source) === JSON.stringify(expected.source), 'Artifact correction request changed the reviewed source edit.');
  assert(JSON.stringify(request.metadata) === JSON.stringify(expected.metadata), 'Artifact correction request changed the reviewed metadata edit.');
  assert(request.termsAccepted === true && request.rightsConfirmed === true, 'Artifact correction did not reconfirm rights and terms.');
  return request;
}

function assertExactSubmittedArtifactChild(parent, child, request, proposalBefore, proposalAfter) {
  assert(['changes_requested', 'rejected'].includes(parent?.reviewState), 'Artifact correction parent has no independently decided review state.');
  assert(UUID_PATTERN.test(parent.artifactId || '') && UUID_PATTERN.test(parent.artifactVersionId || '') && UUID_PATTERN.test(parent.requestId || ''), 'Artifact correction parent IDs are malformed.');
  assert(LOWER_SHA256_PATTERN.test(parent.sourceSha256 || '') && Number.isSafeInteger(parent.sourceBytes) && parent.sourceBytes > 0, 'Artifact correction parent source receipt is malformed.');
  assert(child?.reviewState === 'submitted', 'Artifact correction child is not submitted for independent review.');
  assert(child.artifactId === parent.artifactId, 'Artifact correction child changed artifact identity.');
  assert(UUID_PATTERN.test(child.artifactVersionId || '') && child.artifactVersionId !== parent.artifactVersionId, 'Artifact correction did not create one new immutable version.');
  assert(UUID_PATTERN.test(child.requestId || '') && child.requestId !== parent.requestId, 'Artifact correction did not create one new placement request.');
  assert(child.parentVersionId === parent.artifactVersionId, 'Artifact correction child does not identify the exact reviewed parent.');
  assert(child.version === parent.version + 1, 'Artifact correction child is not the next exact artifact version.');
  assert(child.artifactLockVersion === parent.artifactLockVersion + 1, 'Artifact correction did not advance the artifact lock exactly once.');
  assert(child.workflowVersion === 3, 'Artifact correction child did not complete the create/save/submit workflow exactly once.');
  assert(child.requestKind === parent.requestKind, 'Artifact correction changed request kind.');
  assert(
    JSON.stringify(artifactPlacementReceipt(child.placement, 'Submitted child placement')) ===
      JSON.stringify(artifactPlacementReceipt(parent.placement, 'Reviewed parent placement')),
    'Artifact correction child changed placement.',
  );
  assert(
    JSON.stringify(artifactReplacementReceipt(child.replaces, 'Submitted child replacement')) ===
      JSON.stringify(artifactReplacementReceipt(parent.replaces, 'Reviewed parent replacement')),
    'Artifact correction child changed the live replacement receipt.',
  );
  assert(child.title === request.source.title && child.language === (request.source.language ?? null), 'Artifact correction child changed source identity metadata.');
  assert(child.sourceSha256 === sha256Text(request.source.html), 'Artifact correction child source hash does not match the exact edited HTML.');
  assert(child.sourceBytes === Buffer.byteLength(request.source.html, 'utf8'), 'Artifact correction child source bytes do not match the exact edited HTML.');
  assert(child.sourceSha256 !== parent.sourceSha256, 'Artifact correction child reused the reviewed source bytes unchanged.');
  for (const key of ['description', 'licenceSpdx', 'attribution', 'sourceUrl', 'rightsHolder', 'provenance', 'thirdPartyAssetsDeclared', 'thirdPartyAssetNotes']) {
    assert(child[key] === request.metadata[key], `Artifact correction child changed metadata field ${key}.`);
  }
  assert(JSON.stringify(child.accessibility) === JSON.stringify(request.metadata.accessibility), 'Artifact correction child changed accessibility metadata.');
  assert(child.latestReviewMessage === null, 'Reviewed parent feedback leaked into the submitted child state.');
  assert(proposalAfter.proposalId === proposalBefore.proposalId, 'Artifact correction created a different proposal.');
  assert(proposalAfter.workflowVersion === proposalBefore.workflowVersion + 1, 'Artifact correction did not advance the proposal CAS version exactly once.');
  return {
    parentVersionId: parent.artifactVersionId,
    childVersionId: child.artifactVersionId,
    parentRequestId: parent.requestId,
    childRequestId: child.requestId,
  };
}

function exactTopLevelMarkdownSection(markdown, exactHeading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line === exactHeading);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('# ')) end += 1;
  return lines.slice(start, end).join('\n');
}

function assertCurrentManifestEnvelope(envelope, slug) {
  const manifest = envelope?.manifest;
  assert(manifest && typeof manifest === 'object', 'The edit manifest payload is missing.');
  assert(manifest.manifestVersion === 1, `Unsupported manifest envelope version: ${manifest.manifestVersion}.`);
  assert(manifest.editorContractVersion === CURRENT_EDITOR_CONTRACT, `Expected ${CURRENT_EDITOR_CONTRACT}, observed ${manifest.editorContractVersion}.`);
  assert(UUID_PATTERN.test(manifest.articleId || ''), 'Manifest articleId is not a UUID.');
  assert(UUID_PATTERN.test(manifest.baseRevisionId || ''), 'Manifest baseRevisionId is not a UUID.');
  assert(Number.isSafeInteger(manifest.articleLockVersion) && manifest.articleLockVersion > 0, 'Manifest article lock is invalid.');
  assert(LOWER_GIT_SHA_PATTERN.test(manifest.baseGitCommitSha || ''), 'Manifest base Git commit is not an exact lowercase SHA.');
  assert(LOWER_SHA256_PATTERN.test(manifest.sourceDigest || ''), 'Manifest content SHA-256 is invalid.');
  assert(LOWER_GIT_SHA_PATTERN.test(manifest.baseGitBlobSha || manifest.gitBlobSha || ''), 'Manifest Git blob SHA is invalid.');
  assert(manifest.sourcePath === `content/docs/${slug}.mdx`, `Manifest source path does not match ${slug}.`);
  assert(manifest.slug === slug, `Manifest slug does not match ${slug}.`);
  assert(manifest.offsetEncoding === 'utf16-code-units', `Unexpected offset encoding: ${manifest.offsetEncoding}.`);
  assert(typeof manifest.releaseRevision === 'string' && manifest.releaseRevision.length > 0, 'Manifest release revision is missing.');
  assert(manifest.capabilities && typeof manifest.capabilities === 'object', 'Manifest capabilities are missing.');
  assert(Array.isArray(manifest.blocks) && manifest.blocks.length > 0, 'Manifest has no editable blocks.');
  if (manifest.liveDeliveryBase !== null && manifest.liveDeliveryBase !== undefined) {
    assert(UUID_PATTERN.test(manifest.liveDeliveryBase.activationId || ''), 'Live base activation is invalid.');
    assert(Number.isSafeInteger(manifest.liveDeliveryBase.deliveryLockVersion) && manifest.liveDeliveryBase.deliveryLockVersion > 0, 'Live base delivery lock is invalid.');
    assert(LOWER_SHA256_PATTERN.test(manifest.liveDeliveryBase.structureSha256 || ''), 'Live base structure hash is invalid.');
  }

  let previousEnd = -1;
  const ids = new Set();
  const slots = new Set();
  const allowedKinds = new Set(['paragraph', 'heading', 'list_item', 'blockquote', 'table_cell', 'component_text', 'formula', 'code_block']);
  const allowedModes = new Set(['markdown', 'plain_text', 'formula', 'code']);
  for (const block of manifest.blocks) {
    assert(BLOCK_ID_PATTERN.test(block.blockId || ''), `Malformed v5 block ID: ${block.blockId}.`);
    assert(!ids.has(block.blockId), `Duplicate v5 block ID: ${block.blockId}.`);
    ids.add(block.blockId);
    assert(/^lss_[0-9a-f]{32}$/.test(block.slotId || '') && !slots.has(block.slotId), `Invalid or duplicate stable slot: ${block.slotId}.`);
    slots.add(block.slotId);
    assert(allowedKinds.has(block.blockKind), `Unsupported editable block kind: ${block.blockKind}.`);
    assert(allowedModes.has(block.editMode), `Unsupported edit mode: ${block.editMode}.`);
    assert(Number.isSafeInteger(block.startOffset) && block.startOffset >= previousEnd, `Overlapping/invalid start offset for ${block.blockId}.`);
    assert(Number.isSafeInteger(block.endOffset) && block.endOffset > block.startOffset, `Invalid end offset for ${block.blockId}.`);
    assert(Number.isSafeInteger(block.startByte) && Number.isSafeInteger(block.endByte) && block.endByte > block.startByte, `Invalid byte receipt for ${block.blockId}.`);
    assert(Number.isSafeInteger(block.line) && block.line > 0 && Number.isSafeInteger(block.column) && block.column > 0, `Invalid source position for ${block.blockId}.`);
    assert(/^[0-9a-f]{24}$/.test(block.ancestryFingerprint || ''), `Invalid ancestry fingerprint for ${block.blockId}.`);
    assert(typeof block.ancestryPath === 'string' && block.ancestryPath.length > 0, `Missing ancestry path for ${block.blockId}.`);
    assert(typeof block.originalSource === 'string' && block.originalSource.length > 0, `Missing original source for ${block.blockId}.`);
    assert(sha256Text(block.originalSource) === block.originalSourceSha256, `Original-source hash mismatch for ${block.blockId}.`);
    const expectedId = `lsb_${sha256Text([
      CURRENT_EDITOR_CONTRACT,
      manifest.sourcePath,
      block.ancestryFingerprint,
      block.originalSourceSha256,
      block.typedTarget?.componentShellSha256 ?? '',
      block.codeFence?.fenceShellSha256 ?? '',
    ].join('\0')).slice(0, 32)}`;
    assert(block.blockId === expectedId, `Block identity is not bound to the v5 contract/source/path receipt: ${block.blockId}.`);
    assert(Array.isArray(block.protectedTokens), `Protected-token receipt is missing for ${block.blockId}.`);
    assert(
      block.protectedTokens.every((token) => (
        token?.kind === 'inline_mdx_component' &&
        typeof token.componentName === 'string' &&
        typeof token.value === 'string' &&
        Number.isSafeInteger(token.start) && token.start >= 0 &&
        Number.isSafeInteger(token.end) && token.end >= token.start && token.end <= block.originalSource.length
      )),
      `Malformed protected-token receipt for ${block.blockId}.`,
    );
    assert(
      block.artifactInsertion &&
      typeof block.artifactInsertion.before === 'boolean' &&
      typeof block.artifactInsertion.after === 'boolean',
      `Malformed artifact capability receipt for ${block.blockId}.`,
    );
    previousEnd = block.endOffset;
  }

  return {
    editorContractVersion: manifest.editorContractVersion,
    revisionId: manifest.baseRevisionId,
    articleLockVersion: manifest.articleLockVersion,
    gitCommitSha: manifest.baseGitCommitSha,
    contentSha256: manifest.sourceDigest,
    gitBlobSha: manifest.baseGitBlobSha ?? manifest.gitBlobSha,
    ...(manifest.liveDeliveryBase ? {
      deliveryActivationId: manifest.liveDeliveryBase.activationId,
      structureSha256: manifest.liveDeliveryBase.structureSha256,
    } : {}),
  };
}

function assertExactBaseReceipt(actual, expected, label) {
  const keys = Object.keys(expected).sort();
  assert(actual && typeof actual === 'object' && !Array.isArray(actual), `${label} is missing.`);
  assert(JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(keys), `${label} does not have the exact current base-receipt shape.`);
  assert(keys.every((key) => actual[key] === expected[key]), `${label} does not match the signed v5 manifest.`);
}

function runCurrentContractSelfTest() {
  const sourcePath = 'content/docs/qa/fixture.mdx';
  const originalSource = 'A signed fixture paragraph.';
  const originalSourceSha256 = sha256Text(originalSource);
  const ancestryPath = 'root/paragraph/0';
  const ancestryFingerprint = sha256Text(ancestryPath).slice(0, 24);
  const blockId = `lsb_${sha256Text([
    CURRENT_EDITOR_CONTRACT,
    sourcePath,
    ancestryFingerprint,
    originalSourceSha256,
    '',
    '',
  ].join('\0')).slice(0, 32)}`;
  const envelope = {
    manifest: {
      manifestVersion: 1,
      editorContractVersion: CURRENT_EDITOR_CONTRACT,
      articleId: '123e4567-e89b-42d3-a456-426614174000',
      baseRevisionId: '223e4567-e89b-42d3-a456-426614174000',
      articleLockVersion: 2,
      baseGitCommitSha: 'a'.repeat(40),
      sourceDigest: 'b'.repeat(64),
      gitBlobSha: 'c'.repeat(40),
      sourcePath,
      slug: 'qa/fixture',
      offsetEncoding: 'utf16-code-units',
      releaseRevision: 'a'.repeat(40),
      capabilities: {
        writesEnabled: true,
        termsConfigured: true,
        termsVersion: 'qa',
        termsUrl: 'https://example.org/terms',
        staticArtifactsEnabled: true,
      },
      liveDeliveryBase: {
        activationId: '323e4567-e89b-42d3-a456-426614174000',
        deliveryLockVersion: 3,
        structureReleaseCommit: 'a'.repeat(40),
        structureSha256: 'd'.repeat(64),
        rendererContractVersion: 'library-live-render-v1',
      },
      blocks: [{
        blockId,
        slotId: `lss_${'1'.repeat(32)}`,
        blockKind: 'paragraph',
        editMode: 'markdown',
        startOffset: 1,
        endOffset: originalSource.length + 1,
        startByte: 1,
        endByte: Buffer.byteLength(originalSource, 'utf8') + 1,
        line: 2,
        column: 1,
        ancestryPath,
        ancestryFingerprint,
        originalSource,
        originalSourceSha256,
        editorValue: originalSource,
        typedTarget: null,
        codeFence: null,
        protectedTokens: [],
        placementAnchorId: `lsp_${'2'.repeat(32)}`,
        artifactInsertion: { before: true, after: true, beforeOrdinal: 0, afterOrdinal: 0 },
      }],
    },
  };
  const receipt = assertCurrentManifestEnvelope(envelope, 'qa/fixture');
  assertExactBaseReceipt({ ...receipt }, receipt, 'Preflight v5 base receipt');
  let tamperRejected = false;
  try {
    assertCurrentManifestEnvelope({
      manifest: {
        ...envelope.manifest,
        blocks: [{ ...envelope.manifest.blocks[0], blockId: `lsb_${'0'.repeat(32)}` }],
      },
    }, 'qa/fixture');
  } catch {
    tamperRejected = true;
  }
  assert(tamperRejected, 'Preflight accepted a tampered v5 block identity.');
  return receipt.editorContractVersion;
}

function runArtifactCorrectionContractSelfTest() {
  const parentHtml = '<section><p>Reviewed parent</p></section>';
  const parent = {
    requestId: '423e4567-e89b-42d3-a456-426614174000',
    artifactId: '523e4567-e89b-42d3-a456-426614174000',
    artifactVersionId: '623e4567-e89b-42d3-a456-426614174000',
    version: 1,
    parentVersionId: null,
    artifactLockVersion: 1,
    reviewState: 'changes_requested',
    workflowVersion: 4,
    title: 'Correction fixture',
    language: 'en',
    description: 'Reviewed description',
    licenceSpdx: 'CC-BY-4.0',
    attribution: 'QA contributor',
    sourceUrl: null,
    rightsHolder: 'QA contributor',
    provenance: 'Reviewed provenance',
    thirdPartyAssetsDeclared: false,
    thirdPartyAssetNotes: null,
    accessibility: {
      textFallback: 'Reviewed fallback',
      keyboardReviewed: true,
      screenReaderReviewed: true,
      reducedMotionReviewed: true,
    },
    sourceSha256: sha256Text(parentHtml),
    sourceBytes: Buffer.byteLength(parentHtml, 'utf8'),
    requestKind: 'insert',
    placement: {
      placementAnchorId: `lsp_${'1'.repeat(32)}`,
      position: 'after',
      ordinal: 0,
    },
    replaces: null,
    latestReviewMessage: 'Exact reviewer feedback',
  };
  const correctedFixture = {
    description: 'Corrected description',
    provenance: 'Corrected provenance',
    textFallback: 'Corrected fallback',
    html: '<section><p>Reviewed parent</p><p>Corrected child</p></section>',
  };
  const expected = expectedCorrectionSourceAndMetadata(parent, correctedFixture);
  const baseReceipt = {
    editorContractVersion: CURRENT_EDITOR_CONTRACT,
    revisionId: '723e4567-e89b-42d3-a456-426614174000',
    articleLockVersion: 2,
    gitCommitSha: 'a'.repeat(40),
    contentSha256: 'b'.repeat(64),
    gitBlobSha: 'c'.repeat(40),
    deliveryActivationId: '823e4567-e89b-42d3-a456-426614174000',
    structureSha256: 'd'.repeat(64),
  };
  const proposalBefore = {
    proposalId: '923e4567-e89b-42d3-a456-426614174000',
    workflowVersion: 4,
  };
  const request = {
    articleId: 'a23e4567-e89b-42d3-a456-426614174000',
    baseReceipt,
    proposalId: proposalBefore.proposalId,
    expectedProposalWorkflowVersion: proposalBefore.workflowVersion,
    placement: { ...parent.placement },
    revision: {
      artifactId: parent.artifactId,
      parentVersionId: parent.artifactVersionId,
      expectedArtifactLockVersion: parent.artifactLockVersion,
      replaces: null,
    },
    source: expected.source,
    metadata: expected.metadata,
    termsAccepted: true,
    rightsConfirmed: true,
    termsVersion: 'qa-v1',
    termsUrl: 'https://example.org/terms',
  };
  assertExactArtifactCorrectionRequest(request, {
    articleId: request.articleId,
    proposalId: proposalBefore.proposalId,
    proposalWorkflowVersion: proposalBefore.workflowVersion,
    baseReceipt,
    parent,
    ...expected,
  });
  const child = {
    ...parent,
    requestId: 'b23e4567-e89b-42d3-a456-426614174000',
    artifactVersionId: 'c23e4567-e89b-42d3-a456-426614174000',
    version: 2,
    parentVersionId: parent.artifactVersionId,
    artifactLockVersion: 2,
    reviewState: 'submitted',
    workflowVersion: 3,
    ...expected.metadata,
    title: expected.source.title,
    language: expected.source.language ?? null,
    accessibility: expected.metadata.accessibility,
    sourceSha256: sha256Text(expected.source.html),
    sourceBytes: Buffer.byteLength(expected.source.html, 'utf8'),
    latestReviewMessage: null,
  };
  const proposalAfter = { ...proposalBefore, workflowVersion: proposalBefore.workflowVersion + 1 };
  assertExactSubmittedArtifactChild(parent, child, request, proposalBefore, proposalAfter);
  const rejectedParent = { ...parent, reviewState: 'rejected' };
  assertExactArtifactCorrectionRequest(request, {
    articleId: request.articleId,
    proposalId: proposalBefore.proposalId,
    proposalWorkflowVersion: proposalBefore.workflowVersion,
    baseReceipt,
    parent: rejectedParent,
    ...expected,
  });
  assertExactSubmittedArtifactChild(rejectedParent, child, request, proposalBefore, proposalAfter);

  const rejectedTampering = [
    () => assertExactArtifactCorrectionRequest({ ...request, unexpected: true }, {
      articleId: request.articleId, proposalId: proposalBefore.proposalId,
      proposalWorkflowVersion: proposalBefore.workflowVersion, baseReceipt, parent, ...expected,
    }),
    () => assertExactArtifactCorrectionRequest({
      ...request,
      revision: { ...request.revision, parentVersionId: 'd23e4567-e89b-42d3-a456-426614174000' },
    }, {
      articleId: request.articleId, proposalId: proposalBefore.proposalId,
      proposalWorkflowVersion: proposalBefore.workflowVersion, baseReceipt, parent, ...expected,
    }),
    () => assertExactSubmittedArtifactChild(parent, { ...child, parentVersionId: 'd23e4567-e89b-42d3-a456-426614174000' }, request, proposalBefore, proposalAfter),
    () => assertExactSubmittedArtifactChild(parent, { ...child, artifactVersionId: parent.artifactVersionId }, request, proposalBefore, proposalAfter),
    () => assertExactSubmittedArtifactChild(parent, { ...child, artifactLockVersion: parent.artifactLockVersion }, request, proposalBefore, proposalAfter),
    () => assertExactSubmittedArtifactChild(parent, { ...child, placement: { ...child.placement, ordinal: 1 } }, request, proposalBefore, proposalAfter),
    () => assertExactSubmittedArtifactChild(parent, { ...child, sourceSha256: parent.sourceSha256 }, request, proposalBefore, proposalAfter),
  ];
  for (const tamper of rejectedTampering) {
    let rejected = false;
    try { tamper(); } catch { rejected = true; }
    assert(rejected, 'Artifact correction contract accepted a tampered lineage or source receipt.');
  }
  return {
    reviewStates: ['changes_requested', 'rejected'],
    tamperCases: rejectedTampering.length,
  };
}

async function runHarnessSelfTest(context) {
  const editorContract = runCurrentContractSelfTest();
  const artifactCorrection = runArtifactCorrectionContractSelfTest();
  const rejectedOrigins = [];
  for (const candidate of [
    'https://127.0.0.1:3010',
    'http://127.0.0.1:3010/article',
    'http://127.0.0.1.evil.invalid:3010',
    'http://user:password@127.0.0.1:3010',
  ]) {
    let rejected = false;
    try {
      loopbackOrigin(candidate, 'Self-test origin');
    } catch {
      rejected = true;
    }
    assert(rejected, `Unsafe origin passed the local-only guard: ${candidate}`);
    rejectedOrigins.push(candidate);
  }
  console.log(JSON.stringify({
    ok: true,
    command: 'self-test',
    editorContract,
    acceptedOrigins: [context.libraryOrigin, context.adminOrigin, context.adaOrigin],
    rejectedOriginCount: rejectedOrigins.length,
    artifactCorrection,
  }));
}

async function manifestResponse(connection, libraryOrigin, slug) {
  return pageFetch(connection, `${libraryOrigin}/api/library/edit-manifest/${slug}`);
}

async function waitForStableAuthenticatedEditorAction(connection, articleUrl, timeoutMs = 15_000) {
  const expectedUrl = documentUrl(articleUrl);
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  let stableTimeOrigin = null;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      lastState = await evaluate(connection, `(() => {
        const current = new URL(location.href);
        current.hash = '';
        const rendered = (element) => {
          if (!element?.isConnected) return false;
          if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
        };
        const buttons = Array.from(document.querySelectorAll('button')).filter(rendered);
        const suggestions = buttons.filter((button) => (button.textContent || '').trim() === ${js(AUTHENTICATED_EDITOR_ACTION)});
        const button = suggestions[0];
        if (button) button.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = button?.getBoundingClientRect();
        const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
        return {
          href: current.href,
          ready: document.readyState,
          timeOrigin: performance.timeOrigin,
          suggestionCount: suggestions.length,
          enabled: Boolean(button && !button.disabled && !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true'),
          hitTarget: Boolean(button && hit && (hit === button || button.contains(hit))),
        };
      })()`);
    } catch (error) {
      lastState = { evaluationError: error instanceof Error ? error.message : String(error) };
    }
    const ready = lastState?.href === expectedUrl &&
      lastState?.ready === 'complete' &&
      lastState?.suggestionCount === 1 &&
      lastState?.enabled === true &&
      lastState?.hitTarget === true &&
      Number.isFinite(lastState?.timeOrigin);
    if (ready) {
      if (stableTimeOrigin !== lastState.timeOrigin) {
        stableTimeOrigin = lastState.timeOrigin;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= EDITOR_ACTION_STABILITY_MS) {
        return { expectedUrl, timeOrigin: stableTimeOrigin };
      }
    } else {
      stableSince = null;
      stableTimeOrigin = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`The authenticated article editing action did not remain stable (last state: ${JSON.stringify(lastState)}).`);
}

async function guardedClickAuthenticatedEditorAction(connection, expectedUrl, expectedTimeOrigin) {
  const armed = await evaluate(connection, `(() => {
    window.__lovelaceQaEditorActionGuardCleanup?.();
    delete window.__lovelaceQaEditorActionGuardCleanup;
    delete window.__lovelaceQaEditorActionGuardReceipt;
    const current = new URL(location.href);
    current.hash = '';
    const buttons = Array.from(document.querySelectorAll('button'));
    const suggestions = buttons.filter((button) => (button.textContent || '').trim() === ${js(AUTHENTICATED_EDITOR_ACTION)});
    const button = suggestions[0];
    if (current.href !== ${js(expectedUrl)} || performance.timeOrigin !== ${js(expectedTimeOrigin)} || suggestions.length !== 1 || !button?.isConnected) {
      return { ok: false, reason: 'document-or-action-changed' };
    }
    if (typeof button.checkVisibility === 'function' && !button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return { ok: false, reason: 'not-visible' };
    }
    if (button.disabled || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true') {
      return { ok: false, reason: 'disabled' };
    }
    button.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== button && !button.contains(hit))) return { ok: false, reason: 'occluded' };
    const cleanup = () => document.removeEventListener('click', guard, true);
    const guard = (event) => {
      const target = event.target instanceof Element ? event.target.closest('button') : null;
      const href = (() => { const value = new URL(location.href); value.hash = ''; return value.href; })();
      const text = (button.textContent || '').trim();
      const valid = target === button && button.isConnected && text === ${js(AUTHENTICATED_EDITOR_ACTION)} &&
        href === ${js(expectedUrl)} && performance.timeOrigin === ${js(expectedTimeOrigin)} &&
        !button.disabled && !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true';
      window.__lovelaceQaEditorActionGuardReceipt = { state: valid ? 'allowed' : 'blocked', text, href };
      cleanup();
      delete window.__lovelaceQaEditorActionGuardCleanup;
      if (!valid) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.__lovelaceQaEditorActionGuardCleanup = cleanup;
    document.addEventListener('click', guard, true);
    return { ok: true, x, y };
  })()`);
  if (!armed?.ok) return armed;
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: armed.x, y: armed.y });
  const stillArmed = await evaluate(connection, `(() => {
    const current = new URL(location.href);
    current.hash = '';
    const suggestions = Array.from(document.querySelectorAll('button')).filter((button) => (button.textContent || '').trim() === ${js(AUTHENTICATED_EDITOR_ACTION)});
    return current.href === ${js(expectedUrl)} && performance.timeOrigin === ${js(expectedTimeOrigin)} && suggestions.length === 1;
  })()`);
  if (!stillArmed) {
    await evaluate(connection, `window.__lovelaceQaEditorActionGuardCleanup?.(); delete window.__lovelaceQaEditorActionGuardCleanup;`);
    return { ok: false, reason: 'action-changed-before-click' };
  }
  await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: armed.x, y: armed.y, button: 'left', clickCount: 1 });
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: armed.x, y: armed.y, button: 'left', clickCount: 1 });
  const receipt = await evaluate(connection, 'window.__lovelaceQaEditorActionGuardReceipt || null').catch(() => null);
  return receipt?.state === 'allowed' ? { ok: true } : { ok: false, reason: receipt?.state || 'guard-receipt-missing' };
}

async function openEditor(connection, context) {
  await dismissOptionalCookieBanner(connection);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ready = await waitForStableAuthenticatedEditorAction(connection, context.articleUrl);
    const manifest = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(manifest.status === 200, `Refusing to click the authenticated editor action after manifest status ${manifest.status}.`);
    assertCurrentManifestEnvelope(manifest.body, context.slug);
    const clicked = await guardedClickAuthenticatedEditorAction(connection, ready.expectedUrl, ready.timeOrigin);
    if (!clicked?.ok) continue;
    const deadline = Date.now() + 15_000;
    let lastState = null;
    while (Date.now() < deadline) {
      try {
        lastState = await evaluate(connection, `(() => {
          const current = new URL(location.href);
          current.hash = '';
          return {
            href: current.href,
            editing: document.documentElement.dataset.lsEditing === 'true',
            alert: Boolean(document.querySelector('[role="alert"]')),
          };
        })()`);
      } catch (error) {
        lastState = { evaluationError: error instanceof Error ? error.message : String(error) };
      }
      assert(lastState?.href === ready.expectedUrl, `The authenticated editor action unexpectedly navigated away: ${lastState?.href || 'unknown URL'}.`);
      if (lastState.editing || lastState.alert) return;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    throw new Error(`The editing overlay did not open (last state: ${JSON.stringify(lastState)}).`);
  }
  throw new Error('The authenticated editor action changed before three guarded click attempts; no click was dispatched.');
}

async function editableContext(connection, libraryOrigin, slug) {
  const response = await manifestResponse(connection, libraryOrigin, slug);
  assert(response.status === 200, `Manifest status was ${response.status}, expected 200.`);
  const manifest = response.body;
  const baseReceipt = assertCurrentManifestEnvelope(manifest, slug);
  assert(/private/i.test(response.cacheControl || '') && /no-store/i.test(response.cacheControl || ''), 'Authenticated manifest is not private/no-store.');
  const domBlockIds = await evaluate(
    connection,
    `Array.from(document.querySelectorAll('button[data-ls-edit-trigger]'), (trigger) => trigger.dataset.lsEditTrigger)`,
  );
  const manifestBlockIds = manifest?.manifest?.blocks?.map((block) => block.blockId) ?? [];
  assert(domBlockIds.length > 0, 'No editable content trigger was rendered.');
  assert(new Set(domBlockIds).size === domBlockIds.length, 'The rendered article contains duplicate editable block IDs.');
  assert(new Set(manifestBlockIds).size === manifestBlockIds.length, 'The signed manifest contains duplicate editable block IDs.');
  assert(
    JSON.stringify([...domBlockIds].sort()) === JSON.stringify([...manifestBlockIds].sort()),
    `Rendered/manifest block ID parity failed (${domBlockIds.length} DOM IDs, ${manifestBlockIds.length} manifest IDs).`,
  );
  const [blockId] = domBlockIds;
  assert(blockId, 'No editable content trigger was rendered.');
  const block = manifest?.manifest?.blocks?.find((candidate) => candidate.blockId === blockId);
  assert(block, 'The first DOM block ID is absent from the signed manifest after parity validation.');
  return { response, manifest, baseReceipt, blockId, block };
}

async function assertParagraphAccessibility(connection, blockId) {
  const result = await evaluate(connection, `(() => {
    const trigger = document.querySelector('button[data-ls-edit-trigger=${js(blockId)}]');
    const content = trigger?.closest('[data-ls-block-id]');
    return {
      triggerTag: trigger?.tagName || null,
      triggerLabel: trigger?.getAttribute('aria-label') || null,
      contentRole: content?.getAttribute('role') || null,
      contentTabIndex: content?.getAttribute('tabindex') || null,
    };
  })()`);
  assert(result.triggerTag === 'BUTTON' && /^Edit this /.test(result.triggerLabel || ''), 'The edit control is not an accessible native button.');
  assert(result.contentRole === null && result.contentTabIndex === null, 'Editable content must not masquerade as a button.');

  await focusSelector(connection, `button[data-ls-edit-trigger=${js(blockId)}]`);
  await pressKey(connection, 'Enter');
  await waitUntil(connection, `Boolean(document.querySelector('#library-block-editor-title'))`, 'Enter did not open the paragraph editor.');
  await pressKey(connection, 'Escape');
  await waitUntil(connection, `!document.querySelector('#library-block-editor-title')`, 'Escape did not close the paragraph editor.');
  await waitUntil(
    connection,
    `document.activeElement?.dataset?.lsEditTrigger === ${js(blockId)}`,
    'Focus did not return to the pen button.',
  );
  await pressKey(connection, 'Enter');
  await waitUntil(connection, `Boolean(document.querySelector('#library-block-editor-title'))`, 'The paragraph editor did not reopen.');
}

async function addBlockEdit(connection, blockId, value) {
  const open = await evaluate(connection, `Boolean(document.querySelector('#library-block-editor-title'))`);
  if (!open) {
    await strictClickSelector(connection, `button[data-ls-edit-trigger=${js(blockId)}]`);
    await waitUntil(connection, `Boolean(document.querySelector('#library-block-editor-title'))`, 'Content editor did not open.');
  }
  await fillNative(connection, '#library-proposed-content', value);
  await waitForButtonState(connection, 'Add to proposal', false);
  await strictClickText(connection, 'Add to proposal');
  await waitUntil(connection, `!document.querySelector('#library-block-editor-title')`, 'Content editor did not close after applying.');
}

async function openComposer(connection) {
  await waitForButtonState(connection, 'Review proposal', false);
  await strictClickText(connection, 'Review proposal');
  await waitUntil(connection, `Boolean(document.querySelector('#library-proposal-title'))`, 'Proposal review did not open.');
}

async function configureComposer(connection, { summary, attribution, acceptTerms = false }) {
  await fillNative(connection, 'textarea[placeholder="What did you improve, and why?"]', summary);
  const scopedCount = await evaluate(connection, `document.querySelectorAll('aside[role="dialog"] input[type="checkbox"]').length`);
  assert(scopedCount >= 2, 'The proposal attribution/terms checkboxes are missing.');
  await setDialogCheckbox(connection, 0, true);
  await fillNative(connection, 'aside[role="dialog"] input:not([type="checkbox"])', attribution);
  if (acceptTerms) {
    await setDialogCheckbox(connection, 1, true);
  }
}

async function runPreflight(context) {
  const { port, evidenceDirectory } = context;
  assert(process.version.startsWith('v22.13.'), `Node 22.13.x is required; observed ${process.version}.`);
  const contractSelfTest = runCurrentContractSelfTest();
  const artifactCorrectionContractSelfTest = runArtifactCorrectionContractSelfTest();
  const llmSectionFixture = [
    '# Fixture title (guide/article)',
    'wrong path section with neighbor-only-probe',
    '',
    '# Fixture title (/guide/article)',
    'exact target probe',
    '',
    '# Following article (/guide/following)',
    'following-only-probe',
  ].join('\n');
  const llmSection = exactTopLevelMarkdownSection(llmSectionFixture, '# Fixture title (/guide/article)');
  assert(llmSection.includes('exact target probe') && !llmSection.includes('neighbor-only-probe') && !llmSection.includes('following-only-probe'), 'Exact LLM section boundaries leaked adjacent article content.');
  assert(exactTopLevelMarkdownSection(llmSectionFixture, '# Fixture title (guide/article)') !== llmSection, 'The LLM section fixture ignored the canonical leading slash.');
  const version = await fetchVersion({ port });
  // Headless Brave currently advertises the Chromium product token as
  // `Chrome/...` through /json/version. The private launcher itself pins the
  // installed Brave executable, so this check validates the compatible CDP
  // product/protocol instead of relying on a misleading branding token.
  assert(/^(?:Chrome|Brave)\//.test(String(version.Browser || '')), `Unexpected CDP browser product: ${version.Browser}`);
  const { connection } = await primarySession(port);
  try {
    const smokeUrl = pathToFileURL(path.join(QA_ROOT, 'smoke.html')).href;
    await navigate(connection, smokeUrl);
    assert(await waitForText(connection, 'Agent Navigator preflight', { timeoutMs: 5_000 }), 'waitForText failed its positive smoke case.');
    assert(await waitForSelector(connection, '#message', { timeoutMs: 5_000 }), 'waitForSelector failed its positive smoke case.');
    const fill = await fillByLabel(connection, 'QA message', 'navigator-ok');
    assert(fill?.ok, 'fillByLabel failed its positive smoke case.');
    const click = await clickByText(connection, 'Copy message');
    assert(click?.ok, 'clickByText failed its positive smoke case.');
    assert(await waitForText(connection, 'navigator-ok', { timeoutMs: 5_000 }), 'The smoke action did not update the live region.');
    await fillNative(connection, '#message', 'navigator-enter-ok');
    await focusSelector(connection, '#keyboard-copy');
    await pressKey(connection, 'Enter');
    await waitUntil(
      connection,
      `document.querySelector('#result')?.textContent === 'navigator-enter-ok'`,
      'The text-producing Enter key did not activate a native button.',
      5_000,
    );
    await strictClickSelector(connection, '#delayed-action');
    await waitUntil(
      connection,
      `document.querySelector('#result')?.textContent === 'selector-ok'`,
      'The delayed actionable selector was not clicked.',
      5_000,
    );
    assert(await dismissOptionalCookieBanner(connection), 'The nested cookie-banner hit target was not dismissed.');
    assert(!await evaluate(connection, `Boolean(document.querySelector('#cookie-test'))`), 'The cookie-banner smoke fixture remained in the DOM.');
    const occlusionFixture = await evaluate(connection, `(() => {
      const fixture = document.createElement('div');
      fixture.id = 'selector-occlusion-fixture';
      fixture.style.cssText = 'position:relative;height:1200px';
      const button = document.createElement('button');
      button.id = 'occlusion-reposition-action';
      button.type = 'button';
      button.textContent = 'Repositioned action';
      button.style.cssText = 'position:absolute;top:700px;left:120px';
      const cover = document.createElement('div');
      cover.id = 'selector-center-cover';
      cover.style.cssText = 'position:fixed;inset:40vh 0 0;z-index:100;background:rgba(255,255,255,.98)';
      button.addEventListener('click', () => { window.__lovelaceQaRepositionClicks = (window.__lovelaceQaRepositionClicks || 0) + 1; }, { once: true });
      fixture.append(button);
      document.body.append(fixture, cover);
      window.__lovelaceQaRepositionClicks = 0;
      return true;
    })()`);
    assert(occlusionFixture, 'Could not create the selector occlusion fixture.');
    const repositioned = await strictClickSelector(connection, '#occlusion-reposition-action');
    assert(repositioned?.placement !== 0.5, 'The selector occlusion fixture was not repositioned outside its center cover.');
    assert(await evaluate(connection, 'window.__lovelaceQaRepositionClicks === 1'), 'The repositioned selector action did not receive exactly one click.');
    await evaluate(connection, `document.querySelector('#selector-center-cover')?.remove(); document.querySelector('#selector-occlusion-fixture')?.remove();`);
    const morphFixture = await evaluate(connection, `(() => {
      const button = document.createElement('button');
      button.id = 'auth-morph-test';
      button.type = 'button';
      button.textContent = ${js(AUTHENTICATED_EDITOR_ACTION)};
      button.addEventListener('mouseenter', () => { button.textContent = 'Sign in with Google'; }, { once: true });
      button.addEventListener('click', () => { window.__lovelaceQaAuthMorphClicks = (window.__lovelaceQaAuthMorphClicks || 0) + 1; });
      document.body.append(button);
      window.__lovelaceQaAuthMorphClicks = 0;
      const current = new URL(location.href);
      current.hash = '';
      return { href: current.href, timeOrigin: performance.timeOrigin };
    })()`);
    const morphClick = await guardedClickAuthenticatedEditorAction(connection, morphFixture.href, morphFixture.timeOrigin);
    assert(!morphClick?.ok && morphClick.reason === 'action-changed-before-click', `The auth-morph guard did not stop before click: ${JSON.stringify(morphClick)}.`);
    assert(await evaluate(connection, 'window.__lovelaceQaAuthMorphClicks === 0'), 'The auth-morph fixture received a click after changing to the signed-out action.');
    await evaluate(connection, `document.querySelector('#auth-morph-test')?.remove()`);
    const controlledMutationFixture = await evaluate(connection, `(() => {
      const field = document.createElement('textarea');
      field.id = 'controlled-mutation-field';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Delayed controlled mutation';
      button.disabled = true;
      field.addEventListener('input', () => {
        window.setTimeout(() => { button.disabled = field.value !== 'ready'; }, 250);
      });
      button.addEventListener('click', () => { window.__lovelaceQaControlledMutationClicks = (window.__lovelaceQaControlledMutationClicks || 0) + 1; });
      document.body.append(field, button);
      window.__lovelaceQaControlledMutationClicks = 0;
      return true;
    })()`);
    assert(controlledMutationFixture, 'Could not create the controlled mutation fixture.');
    await fillNative(connection, '#controlled-mutation-field', 'ready');
    await waitForButtonState(connection, 'Delayed controlled mutation', false, 5_000);
    await strictClickText(connection, 'Delayed controlled mutation');
    assert(await evaluate(connection, 'window.__lovelaceQaControlledMutationClicks === 1'), 'The controlled mutation action did not wait for its enabled React-like state.');
    await evaluate(connection, `document.querySelector('#controlled-mutation-field')?.remove(); Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').trim() === 'Delayed controlled mutation')?.remove();`);
    const delayedRenderFixture = await evaluate(connection, `(() => {
      window.__lovelaceQaDelayedRenderClicks = 0;
      window.setTimeout(() => {
        const button = document.createElement('button');
        button.id = 'delayed-render-control';
        button.type = 'button';
        button.textContent = 'Delayed rendered control';
        button.addEventListener('click', () => { window.__lovelaceQaDelayedRenderClicks += 1; }, { once: true });
        document.body.append(button);
      }, 250);
      return true;
    })()`);
    assert(delayedRenderFixture, 'Could not schedule the delayed-render control fixture.');
    const delayedRenderState = await assertButton(connection, 'Delayed rendered control', false);
    assert(delayedRenderState.found && delayedRenderState.disabled === false, 'The delayed-render control did not settle enabled.');
    await strictClickText(connection, 'Delayed rendered control');
    assert(await evaluate(connection, 'window.__lovelaceQaDelayedRenderClicks === 1'), 'The delayed-render control did not receive exactly one click.');
    await evaluate(connection, `document.querySelector('#delayed-render-control')?.remove()`);
    const nestedDossierFixture = await evaluate(connection, `(() => {
      const outer = document.createElement('section');
      outer.id = 'nested-dossier-fixture';
      const outerTitle = document.createElement('h2');
      outerTitle.textContent = 'Library edit review';
      const outerSummary = document.createElement('p');
      outerSummary.textContent = 'Wrong outer summary';
      const dossier = document.createElement('section');
      const dossierTitle = document.createElement('h3');
      dossierTitle.textContent = 'Proposal dossier';
      const dossierSummary = document.createElement('p');
      dossierSummary.textContent = 'Exact nested QA summary';
      const metadata = document.createElement('dl');
      metadata.innerHTML = '<dt>Editor contract</dt><dd>library-content-editor-v5</dd>';
      dossier.append(dossierTitle, dossierSummary, metadata);
      const validation = document.createElement('section');
      const validationTitle = document.createElement('h3');
      validationTitle.textContent = 'Validation report';
      const report = document.createElement('pre');
      report.textContent = JSON.stringify({ valid: true, nested_fixture: true });
      validation.append(validationTitle, report);
      outer.append(outerTitle, outerSummary, dossier, validation);
      document.body.append(outer);
      return true;
    })()`);
    assert(nestedDossierFixture, 'Could not create the nested Admin dossier fixture.');
    const nestedDossier = await readAdminDossier(connection);
    assert(nestedDossier.summary === 'Exact nested QA summary', `Nested dossier selection escaped to the outer section: ${nestedDossier.summary}.`);
    assert(nestedDossier.metadata['Editor contract'] === CURRENT_EDITOR_CONTRACT && nestedDossier.report?.nested_fixture === true, 'Nested dossier/validation selection mixed section receipts.');
    await evaluate(connection, `document.querySelector('#nested-dossier-fixture')?.remove()`);
    const snapshot = await snapshotPage(connection);
    assert(snapshot.headings.includes('Agent Navigator preflight'), 'snapshotPage omitted the smoke heading.');
    const output = await screenshot(connection, evidenceDirectory, '00-agent-navigator-preflight');
    await reload(connection);
    await waitUntil(
      connection,
      `document.querySelector('#message')?.value === '' && document.querySelector('#result')?.textContent === 'Waiting' && document.querySelector('#delayed-action')?.hidden === true`,
      'The true new-document reload did not reset the smoke fixture.',
      5_000,
    );
    await emitResult(context, {
      ok: true,
      command: 'preflight',
      node: process.version,
      browser: version.Browser,
      contractSelfTest,
      artifactCorrectionContractSelfTest,
      helperSelfTests: ['new-document-navigation', 'new-document-reload', 'text-producing-enter', 'actionable-selector-wait', 'occlusion-aware-selector-positioning', 'cookie-descendant-hit-target', 'authenticated-action-morph-guard', 'controlled-mutation-state-wait', 'delayed-render-button-assertion', 'nearest-exact-admin-section', 'exact-llms-full-section-boundaries'],
      screenshot: output,
    });
  } finally {
    await connection.close();
  }
}

async function runEditorAuthSmoke(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    await openEditor(connection, context);
    const manifest = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(manifest.status === 200, `Authenticated editor smoke manifest returned ${manifest.status}.`);
    const baseReceipt = assertCurrentManifestEnvelope(manifest.body, context.slug);
    const blockId = await evaluate(connection, `document.querySelector('button[data-ls-edit-trigger]')?.dataset?.lsEditTrigger || null`);
    assert(blockId && BLOCK_ID_PATTERN.test(blockId), 'Authenticated editor smoke did not render a valid paragraph trigger.');
    const paragraphClick = await strictClickSelector(connection, `button[data-ls-edit-trigger=${js(blockId)}]`);
    await waitUntil(connection, `Boolean(document.querySelector('#library-block-editor-title'))`, 'Authenticated editor smoke could not pointer-open the paragraph editor above the fixed editing panel.');
    await pressKey(connection, 'Escape');
    await waitUntil(connection, `!document.querySelector('#library-block-editor-title')`, 'Authenticated editor smoke did not close the paragraph editor.');
    const href = await evaluate(connection, `(() => { const current = new URL(location.href); current.hash = ''; return current.href; })()`);
    assert(href === documentUrl(context.articleUrl), `Authenticated editor smoke navigated away to ${href}.`);
    const output = await screenshot(connection, context.evidenceDirectory, '00-editor-auth-smoke');
    await emitResult(context, {
      ok: true,
      command: 'editor-auth-smoke',
      editorContract: baseReceipt.editorContractVersion,
      paragraphPointerActivation: true,
      paragraphPlacement: paragraphClick.placement,
      stayedOnArticle: true,
      screenshot: output,
    });
  } finally { await connection.close(); }
}

async function runLocalLogin(context) {
  const { connection } = await primarySession(context.port);
  try {
    const destination = context.loginDestination;
    const expectedDestination = new URL(destination, context.adminOrigin);
    await navigate(connection, `${context.adminOrigin}/login?next=${encodeURIComponent(destination)}`);
    await waitUntil(
      connection,
      `Array.from(document.querySelectorAll('button')).some((button) => (button.textContent || '').trim() === 'Use local tester')`,
      'Admin did not expose the localhost-only tester action.',
    );
    await strictClickText(connection, 'Use local tester');
    await waitUntil(
      connection,
      `location.origin === ${js(context.adminOrigin)} && location.pathname === ${js(expectedDestination.pathname)} && location.search === ${js(expectedDestination.search)} && location.hash === ${js(expectedDestination.hash)} && document.readyState === 'complete'`,
      `The local tester did not reach ${destination}.`,
      30_000,
    );
    assert(
      await evaluate(connection, `!document.body.innerText.includes('Authentication failed')`),
      'Admin reported a local tester authentication failure.',
    );
    if (destination === '/review/library-edits') {
      assert(
        await evaluate(connection, `document.body.innerText.includes('Review Library edits')`),
        'The default contributor/reviewer login did not reach the protected review workspace.',
      );
    } else if (destination === '/unauthorized') {
      assert(
        await evaluate(connection, `document.body.innerText.includes('Access denied')`),
        'The member login did not render the authenticated access-denied page.',
      );
      await navigateNewDocument(connection, `${context.adminOrigin}/review/library-edits`);
      await waitUntil(
        connection,
        `location.origin === ${js(context.adminOrigin)} && location.pathname === '/unauthorized' && document.body.innerText.includes('Access denied')`,
        'The member session was not authenticated-and-denied by the protected review route.',
        30_000,
      );
    }
    const output = await screenshot(connection, context.evidenceDirectory, `00-local-login-${context.profileLabel}`);
    await emitResult(context, { ok: true, command: 'local-login', profile: context.profileLabel, destination, screenshot: output }, safeEvidenceName(destination));
  } finally { await connection.close(); }
}

async function runSignedOut(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    await waitUntil(connection, `Array.from(document.querySelectorAll('button')).some((button) => (button.textContent || '').includes('Sign in with Google'))`, 'The signed-out Google account action was not shown.');
    const controls = await evaluate(connection, `(() => {
      const rendered = (element) => {
        if (!element?.isConnected) return false;
        if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      };
      const actionable = (element) => rendered(element) && !element.disabled && !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true';
      return {
        editing: document.documentElement.dataset.lsEditing === 'true',
        suggest: Array.from(document.querySelectorAll('button')).filter((button) => actionable(button) && (button.textContent || '').trim() === 'Suggest an edit').length,
        pens: Array.from(document.querySelectorAll('button[data-ls-edit-trigger]')).filter(actionable).length,
        artifacts: Array.from(document.querySelectorAll('button[data-ls-artifact-trigger],button[data-ls-artifact-edit-id]')).filter(actionable).length,
      };
    })()`);
    assert(!controls.editing && controls.suggest === 0 && controls.pens === 0 && controls.artifacts === 0, `Signed-out editing controls leaked: ${JSON.stringify(controls)}.`);
    const response = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(response.status === 401 && errorCode(response) === 'sign_in_required', `Expected sign_in_required/401, observed ${response.status}/${errorCode(response)}.`);
    const output = await screenshot(connection, context.evidenceDirectory, '01-signed-out');
    await emitResult(context, { ok: true, command: 'signed-out', hiddenEditingControls: controls, screenshot: output });
  } finally { await connection.close(); }
}

async function runExpectManifestError(context, flags) {
  const expectedStatus = Number(option(flags, 'status', '403'));
  const expectedCode = option(flags, 'code', 'article_not_enabled');
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    const response = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(response.status === expectedStatus && errorCode(response) === expectedCode, `Expected ${expectedCode}/${expectedStatus}, observed ${errorCode(response)}/${response.status}.`);
    await emitResult(context, { ok: true, command: 'expect-manifest-error', slug: context.slug, status: response.status, code: errorCode(response) }, expectedCode);
  } finally { await connection.close(); }
}

async function runRoleDenied(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    await waitUntil(connection, `Array.from(document.querySelectorAll('button')).some((button) => (button.textContent || '').includes('Suggest an edit'))`, 'Authenticated editing action was not shown.');
    const response = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(response.status === 403 && errorCode(response) === 'role_not_enabled', `Expected role_not_enabled/403, observed ${response.status}/${errorCode(response)}.`);
    await strictClickText(connection, 'Suggest an edit');
    await waitUntil(connection, `document.body.innerText.includes('not enabled for your account')`, 'The role denial was not rendered.');
    assert(await evaluate(connection, `document.documentElement.dataset.lsEditing !== 'true'`), 'Role-denied account entered editing mode.');
    const output = await screenshot(connection, context.evidenceDirectory, '03-role-denied');
    await emitResult(context, { ok: true, command: 'role-denied', screenshot: output });
  } finally { await connection.close(); }
}

async function assertBaseReceiptGuards(connection, context, manifestEnvelope, block, baseReceipt) {
  const proposedFragment = `${block.originalSource} Base-receipt guard.`;
  const common = {
    articleId: manifestEnvelope.manifest.articleId,
    operations: [{
      blockId: block.blockId,
      originalBlockSha256: block.originalSourceSha256,
      proposedFragment,
    }],
    summary: `${context.summary} base-receipt guard`,
    attributionName: context.attribution,
    publishAttribution: true,
    termsAccepted: false,
    termsVersion: manifestEnvelope.manifest.capabilities.termsVersion,
    termsUrl: manifestEnvelope.manifest.capabilities.termsUrl,
    submit: false,
  };
  const mutateHex = (value) => `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
  const mutateUuid = (value) => `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`;
  const cases = [
    { name: 'missing', receipt: undefined, status: 400, code: 'base_receipt_required' },
    { name: 'malformed-uppercase-commit', receipt: { ...baseReceipt, gitCommitSha: 'A'.repeat(40) }, status: 400, code: 'base_receipt_required' },
    { name: 'historical-contract', receipt: { ...baseReceipt, editorContractVersion: 'library-typed-component-v4' }, status: 409, code: 'editor_contract_changed' },
    { name: 'revision-drift', receipt: { ...baseReceipt, revisionId: mutateUuid(baseReceipt.revisionId) }, status: 409, code: 'stale_article_base' },
    { name: 'article-lock-drift', receipt: { ...baseReceipt, articleLockVersion: baseReceipt.articleLockVersion + 1 }, status: 409, code: 'stale_article_base' },
    { name: 'commit-drift', receipt: { ...baseReceipt, gitCommitSha: mutateHex(baseReceipt.gitCommitSha) }, status: 409, code: 'stale_article_base' },
    { name: 'content-drift', receipt: { ...baseReceipt, contentSha256: mutateHex(baseReceipt.contentSha256) }, status: 409, code: 'stale_article_base' },
    { name: 'blob-drift', receipt: { ...baseReceipt, gitBlobSha: mutateHex(baseReceipt.gitBlobSha) }, status: 409, code: 'stale_article_base' },
    ...(baseReceipt.deliveryActivationId ? [
      { name: 'activation-drift', receipt: { ...baseReceipt, deliveryActivationId: mutateUuid(baseReceipt.deliveryActivationId) }, status: 409, code: 'stale_article_base' },
      { name: 'structure-drift', receipt: { ...baseReceipt, structureSha256: mutateHex(baseReceipt.structureSha256) }, status: 409, code: 'stale_article_base' },
    ] : []),
  ];

  for (const guard of cases) {
    const payload = { ...common };
    if (guard.receipt !== undefined) payload.baseReceipt = guard.receipt;
    const response = await pageFetch(connection, `${context.libraryOrigin}/api/library/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert(
      response.status === guard.status && errorCode(response) === guard.code,
      `Base-receipt guard ${guard.name} expected ${guard.code}/${guard.status}, observed ${errorCode(response)}/${response.status}.`,
    );
  }
  const after = await manifestResponse(connection, context.libraryOrigin, context.slug);
  assert(after.status === 200 && after.body.openProposal === null, 'A rejected base-receipt probe mutated proposal state.');
  assertExactBaseReceipt(assertCurrentManifestEnvelope(after.body, context.slug), baseReceipt, 'Manifest receipt after base-receipt guards');
  return cases.map(({ name, status, code }) => ({ name, status, code }));
}

async function withdrawExactProposal(connection, context, proposal) {
  assert(proposal?.status === 'draft', 'Withdrawal requires one exact draft proposal.');
  assert(UUID_PATTERN.test(proposal.proposalId) && Number.isSafeInteger(proposal.workflowVersion) && proposal.workflowVersion > 0, 'The QA draft receipt is malformed.');
  const resourcePath = `/api/library/proposals/${encodeURIComponent(proposal.proposalId)}`;
  const withdrawn = await pageFetch(connection, `${context.libraryOrigin}${resourcePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedWorkflowVersion: proposal.workflowVersion }),
  });
  assert(withdrawn.status === 200 && withdrawn.body.status === 'withdrawn', `QA draft withdrawal returned ${withdrawn.status}/${errorCode(withdrawn)}.`);
  assert(/private/i.test(withdrawn.cacheControl || '') && /no-store/i.test(withdrawn.cacheControl || ''), 'Withdrawal response is not private/no-store.');
  assert(
    withdrawn.body.proposalId === proposal.proposalId && withdrawn.body.workflowVersion === proposal.workflowVersion + 1,
    'QA draft withdrawal did not advance the exact proposal receipt by one workflow version.',
  );
  const after = await manifestResponse(connection, context.libraryOrigin, context.slug);
  assert(after.status === 200 && after.body.openProposal === null, 'The withdrawn QA draft remains open.');
  assert(
    after.body.latestProposal?.proposalId === proposal.proposalId &&
    after.body.latestProposal?.status === 'withdrawn' &&
    after.body.latestProposal?.workflowVersion === withdrawn.body.workflowVersion,
    'The exact withdrawn QA draft is missing from contributor history.',
  );
  const status = await pageFetch(connection, `${context.libraryOrigin}${resourcePath}`);
  assert(status.status === 200 && status.body?.proposal?.proposalId === proposal.proposalId, `Withdrawn proposal status returned ${status.status}.`);
  assert(status.body.proposal.status === 'withdrawn' && status.body.proposal.workflowVersion === withdrawn.body.workflowVersion, 'Proposal status did not confirm the withdrawal receipt.');
  assert(/private/i.test(status.cacheControl || '') && /no-store/i.test(status.cacheControl || ''), 'Proposal status response is not private/no-store.');
  return { resourcePath, workflowVersion: withdrawn.body.workflowVersion };
}

async function runWithdrawOpenDraft(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    const before = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(before.status === 200, `Draft recovery manifest returned ${before.status}.`);
    assertCurrentManifestEnvelope(before.body, context.slug);
    const proposal = before.body.openProposal;
    assert(proposal?.status === 'draft', 'Draft recovery requires one open draft.');
    assert(proposal.summary === context.summary, 'Refusing to withdraw a draft that does not belong to this exact QA run.');
    const result = await withdrawExactProposal(connection, context, proposal);
    await emitResult(context, {
      ok: true,
      command: 'withdraw-open-draft',
      proposalId: proposal.proposalId,
      withdrawalEndpoint: result.resourcePath,
      withdrawalMethod: 'POST',
      workflowVersion: result.workflowVersion,
    });
  } finally { await connection.close(); }
}

async function installProposalRequestCapture(connection) {
  const installed = await evaluate(connection, `(() => {
    if (window.__lovelaceQaOriginalFetch) return false;
    const original = window.fetch;
    window.__lovelaceQaProposalRequests = [];
    window.__lovelaceQaOriginalFetch = original;
    window.fetch = async function(input, init) {
      try {
        const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        const url = new URL(rawUrl, location.href);
        if (url.origin === location.origin && url.pathname === '/api/library/proposals' && String(init?.method || 'GET').toUpperCase() === 'POST') {
          window.__lovelaceQaProposalRequests.push(JSON.parse(String(init?.body || 'null')));
        }
      } catch (error) {
        window.__lovelaceQaCaptureError = error instanceof Error ? error.message : String(error);
      }
      return original.apply(this, arguments);
    };
    return true;
  })()`);
  assert(installed, 'Could not install the one-shot proposal request capture.');
}

async function takeProposalRequestCapture(connection) {
  const capture = await evaluate(connection, `(() => {
    const requests = Array.isArray(window.__lovelaceQaProposalRequests) ? window.__lovelaceQaProposalRequests : [];
    const error = window.__lovelaceQaCaptureError || null;
    if (window.__lovelaceQaOriginalFetch) window.fetch = window.__lovelaceQaOriginalFetch;
    delete window.__lovelaceQaOriginalFetch;
    delete window.__lovelaceQaProposalRequests;
    delete window.__lovelaceQaCaptureError;
    return { requests, error };
  })()`);
  assert(!capture.error, `Proposal request capture failed: ${capture.error}`);
  assert(capture.requests.length === 1, `Expected one UI proposal request, observed ${capture.requests.length}.`);
  return capture.requests[0];
}

async function installArtifactRequestCapture(connection) {
  const installed = await evaluate(connection, `(() => {
    if (window.__lovelaceQaArtifactOriginalFetch) return false;
    const original = window.fetch;
    window.__lovelaceQaArtifactRequests = [];
    window.__lovelaceQaArtifactCaptureError = null;
    window.__lovelaceQaArtifactOriginalFetch = original;
    window.fetch = async function(input, init) {
      try {
        const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        const url = new URL(rawUrl, location.href);
        if (url.origin === location.origin && url.pathname === '/api/library/artifacts' && String(init?.method || 'GET').toUpperCase() === 'POST') {
          window.__lovelaceQaArtifactRequests.push(JSON.parse(String(init?.body || 'null')));
        }
      } catch (error) {
        window.__lovelaceQaArtifactCaptureError = error instanceof Error ? error.message : String(error);
      }
      return original.apply(this, arguments);
    };
    return true;
  })()`);
  assert(installed, 'Could not install the one-shot artifact request capture.');
}

async function takeArtifactRequestCapture(connection) {
  const capture = await evaluate(connection, `(() => {
    const requests = Array.isArray(window.__lovelaceQaArtifactRequests) ? window.__lovelaceQaArtifactRequests : [];
    const error = window.__lovelaceQaArtifactCaptureError || null;
    if (window.__lovelaceQaArtifactOriginalFetch) window.fetch = window.__lovelaceQaArtifactOriginalFetch;
    delete window.__lovelaceQaArtifactOriginalFetch;
    delete window.__lovelaceQaArtifactRequests;
    delete window.__lovelaceQaArtifactCaptureError;
    return { requests, error };
  })()`);
  assert(!capture.error, `Artifact request capture failed: ${capture.error}`);
  assert(capture.requests.length === 1, `Expected one UI artifact request, observed ${capture.requests.length}.`);
  return capture.requests[0];
}

async function temporaryControlForLabel(connection, labelText, selector = 'input,textarea') {
  const attribute = `data-ls-qa-field-${createHash('sha256').update(`${labelText}:${selector}`).digest('hex').slice(0, 12)}`;
  const found = await evaluate(connection, `(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const label = Array.from(document.querySelectorAll('label')).find((candidate) => normalize(candidate.innerText).startsWith(${js(labelText)}));
    const control = label?.querySelector(${js(selector)});
    if (!control) return false;
    document.querySelectorAll('[${attribute}]').forEach((candidate) => candidate.removeAttribute('${attribute}'));
    control.setAttribute('${attribute}', '');
    return true;
  })()`);
  assert(found, `Could not find ${selector} for label ${labelText}.`);
  return `[${attribute}]`;
}

async function fillExactLabel(connection, labelText, value, selector = 'input,textarea') {
  const control = await temporaryControlForLabel(connection, labelText, selector);
  await fillNative(connection, control, value);
  await evaluate(connection, `document.querySelector(${js(control)})?.removeAttribute(${js(control.slice(1, -1))})`);
}

async function readExactLabelValue(connection, labelText, selector = 'input,textarea') {
  const control = await temporaryControlForLabel(connection, labelText, selector);
  const value = await evaluate(connection, `document.querySelector(${js(control)})?.value ?? null`);
  await evaluate(connection, `document.querySelector(${js(control)})?.removeAttribute(${js(control.slice(1, -1))})`);
  assert(typeof value === 'string', `The ${labelText} field has no readable value.`);
  return value;
}

async function readExactLabelCheckbox(connection, labelText) {
  const control = await temporaryControlForLabel(connection, labelText, 'input[type="checkbox"]');
  const value = await evaluate(connection, `document.querySelector(${js(control)})?.checked ?? null`);
  await evaluate(connection, `document.querySelector(${js(control)})?.removeAttribute(${js(control.slice(1, -1))})`);
  assert(typeof value === 'boolean', `The ${labelText} checkbox has no readable value.`);
  return value;
}

async function setExactLabelCheckbox(connection, labelText, checked = true) {
  const control = await temporaryControlForLabel(connection, labelText, 'input[type="checkbox"]');
  const current = await evaluate(connection, `document.querySelector(${js(control)})?.checked === true`);
  if (current !== checked) await strictClickSelector(connection, control);
  const settled = await evaluate(connection, `document.querySelector(${js(control)})?.checked === ${js(checked)}`);
  assert(settled, `Checkbox ${labelText} did not settle to ${checked}.`);
  await evaluate(connection, `document.querySelector(${js(control)})?.removeAttribute(${js(control.slice(1, -1))})`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function runContributorStage(context) {
  const { connection } = await primarySession(context.port);
  try {
    const fixture = artifactFixtures(context).initial;
    await navigate(connection, context.articleUrl);
    await openEditor(connection, context);
    const { manifest, baseReceipt } = await editableContext(connection, context.libraryOrigin, context.slug);
    assert(manifest.openProposal === null, 'Contributor staging requires a fresh disposable canary with no open proposal.');
    assert(manifest.manifest.capabilities.writesEnabled && manifest.manifest.capabilities.termsConfigured, 'Writes and contribution terms must be active in the isolated stack.');
    assert(manifest.manifest.capabilities.staticArtifactsEnabled === true, 'Static artifact intake is not available for this isolated canary.');
    assert(manifest.manifest.liveDeliveryBase, 'The canary has no exact live-delivery base receipt.');

    const markdownBlock = manifest.manifest.blocks.find((candidate) => candidate.editMode === 'markdown' && candidate.blockKind === 'paragraph');
    const typedBlock = manifest.manifest.blocks.find((candidate) => candidate.typedTarget && candidate.editMode === 'plain_text' && candidate.blockId !== markdownBlock?.blockId);
    assert(markdownBlock, 'The canary has no Markdown paragraph block.');
    assert(typedBlock, 'The canary has no plain-text typed component field; choose a representative v5 article.');
    await assertParagraphAccessibility(connection, markdownBlock.blockId);
    await pressKey(connection, 'Escape');
    const receiptGuards = await assertBaseReceiptGuards(connection, context, manifest, markdownBlock, baseReceipt);

    await strictClickSelector(connection, `button[data-ls-edit-trigger=${js(markdownBlock.blockId)}]`);
    await waitUntil(connection, `Boolean(document.querySelector('#library-block-editor-title'))`, 'Markdown editor did not open.');
    const markdownText = `${markdownBlock.editorValue} **${context.probe}**`;
    await fillNative(connection, '#library-proposed-content', markdownText);
    await waitUntil(connection, `Array.from(document.querySelectorAll('[aria-label="Rendered Markdown preview"] strong')).some((node) => (node.textContent || '').includes(${js(context.probe)}))`, 'Safe Markdown did not autorender as strong text.');
    await waitForButtonState(connection, 'Add to proposal', false);
    await strictClickText(connection, 'Add to proposal');
    await waitUntil(connection, `!document.querySelector('#library-block-editor-title')`, 'Markdown editor did not close after applying.');

    await strictClickSelector(connection, `button[data-ls-edit-trigger=${js(typedBlock.blockId)}]`);
    await waitUntil(connection, `Boolean(document.querySelector('#library-block-editor-title'))`, 'Typed component editor did not open.');
    const typedText = `${context.probe} typed field`;
    await fillNative(connection, '#library-proposed-content', typedText);
    await waitUntil(connection, `document.body.innerText.includes(${js(typedText)})`, 'Typed component preview did not update.');
    await waitForButtonState(connection, 'Add to proposal', false);
    await strictClickText(connection, 'Add to proposal');

    await openComposer(connection);
    await configureComposer(connection, { summary: context.summary, attribution: context.attribution });
    await installProposalRequestCapture(connection);
    await strictClickText(connection, 'Save draft');
    await waitUntil(connection, `document.body.innerText.includes('Draft saved')`, 'Draft status did not appear.');
    const capturedRequest = await takeProposalRequestCapture(connection);
    assertExactBaseReceipt(capturedRequest.baseReceipt, baseReceipt, 'UI proposal base receipt');
    assert(capturedRequest.articleId === manifest.manifest.articleId, 'UI proposal request changed articleId.');
    assert(Array.isArray(capturedRequest.operations) && capturedRequest.operations.length === 2, 'The v5 draft did not contain the exact Markdown and typed operations.');
    const saved = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(saved.status === 200 && saved.body.openProposal?.status === 'draft', 'The saved draft was not returned by the manifest.');
    assertExactBaseReceipt(assertCurrentManifestEnvelope(saved.body, context.slug), baseReceipt, 'Saved draft base receipt');
    assert(saved.body.openProposal.summary === context.summary, 'Draft summary was not persisted.');
    assert(saved.body.openProposal.attributionName === context.attribution && saved.body.openProposal.publishAttribution === true, 'Attribution metadata was not persisted.');
    await strictClickText(connection, 'Back');

    const insertion = await evaluate(connection, `document.querySelector('button[data-ls-artifact-trigger]')?.getAttribute('aria-label') || null`);
    assert(insertion, 'The current v5 article exposed no safe static-artifact insertion coordinate.');
    await strictClickSelector(connection, 'button[data-ls-artifact-trigger]');
    await waitUntil(connection, `Boolean(document.querySelector('#artifact-dialog-title'))`, 'Static artifact editor did not open.');
    await fillExactLabel(connection, 'HTML and CSS', '<script>window.__lovelaceQaArtifactExecuted=true</script>');
    await waitUntil(connection, `document.querySelector('#artifact-validation-status')?.textContent?.includes('Fix the issues')`, 'Executable artifact input was not rejected.', 15_000);
    await assertButton(connection, 'Submit artifact for review', true);
    assert(await evaluate(connection, `window.__lovelaceQaArtifactExecuted !== true && !document.querySelector('iframe[srcdoc]')`), 'Executable artifact input reached an active DOM sink.');

    await fillExactLabel(connection, 'Title', context.artifactTitle, 'input');
    await fillExactLabel(connection, 'Short description', fixture.description, 'textarea');
    await fillExactLabel(connection, 'Provenance', fixture.provenance, 'textarea');
    await fillExactLabel(connection, 'Text fallback', fixture.textFallback, 'textarea');
    await fillExactLabel(connection, 'HTML and CSS', fixture.html, 'textarea');
    await setExactLabelCheckbox(connection, 'Keyboard review completed');
    await setExactLabelCheckbox(connection, 'Screen-reader review completed');
    await setExactLabelCheckbox(connection, 'Reduced-motion review completed');
    await setExactLabelCheckbox(connection, 'I confirm that I hold the rights');
    await setExactLabelCheckbox(connection, 'I accept the');
    await waitUntil(connection, `document.querySelector('#artifact-validation-status')?.textContent?.includes('Safe static preview ready.')`, 'Safe artifact rendition did not validate.', 30_000);
    const sandbox = await evaluate(connection, `(() => { const frame = document.querySelector('iframe[title^="Preview of"]'); return frame ? { sandbox: frame.getAttribute('sandbox'), referrer: frame.getAttribute('referrerpolicy'), src: frame.getAttribute('src') } : null; })()`);
    assert(sandbox && sandbox.sandbox === '' && sandbox.referrer === 'no-referrer' && !String(sandbox.src).startsWith('http'), `Artifact preview sandbox is unsafe: ${JSON.stringify(sandbox)}.`);
    await waitForButtonState(connection, 'Submit artifact for review', false, 30_000);
    await strictClickText(connection, 'Submit artifact for review');
    await waitUntil(connection, `!document.querySelector('#artifact-dialog-title') && document.querySelector('[aria-label="Artifact review status"]')?.innerText.includes(${js(context.artifactTitle)}) && document.querySelector('[aria-label="Artifact review status"]')?.innerText.toLowerCase().includes('submitted')`, 'Artifact request was not staged on the draft.', 30_000);
    const staged = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(staged.body.openProposal?.status === 'draft' && staged.body.openProposal?.artifacts?.length === 1, 'The staged artifact is not bound to the exact draft.');
    const output = await screenshot(connection, context.evidenceDirectory, '04-contributor-staged-v5');
    await emitResult(context, {
      ok: true,
      command: 'contributor-stage',
      editorContract: baseReceipt.editorContractVersion,
      baseReceiptGuards: receiptGuards,
      proposalId: staged.body.openProposal.proposalId,
      workflowVersion: staged.body.openProposal.workflowVersion,
      artifactTitle: context.artifactTitle,
      blockKinds: [markdownBlock.blockKind, typedBlock.blockKind],
      sandbox,
      screenshot: output,
    });
  } finally { await connection.close(); }
}

async function openExactSubmittedArtifact(connection, context, expectedVersion = null) {
  await navigate(connection, `${context.adminOrigin}/review/html-artifacts?q=${encodeURIComponent(context.artifactTitle)}`);
  await waitUntil(connection, `document.body.innerText.includes('Review static Library artifacts') && document.body.innerText.includes(${js(context.artifactTitle)})`, 'The exact artifact was not found in the Admin queue.', 30_000);
  const selected = await evaluate(connection, `(() => {
    const matches = Array.from(document.querySelectorAll('a[href*="/review/html-artifacts"]')).filter((link) => (
      Array.from(link.querySelectorAll('p')).some((node) => (node.textContent || '').trim() === ${js(context.artifactTitle)})
    ));
    const versionText = Array.from(matches[0]?.querySelectorAll('p') || [])
      .map((node) => (node.textContent || '').trim())
      .find((text) => /(?:^|\s)v\d+\s*$/i.test(text)) || '';
    return { count: matches.length, href: matches[0]?.href || null, text: matches[0]?.innerText || '', versionText };
  })()`);
  assert(selected.count === 1 && selected.href, `Artifact search did not identify exactly one submitted immutable version: ${JSON.stringify(selected)}.`);
  const versionMatch = String(selected.versionText).match(/\bv(\d+)\s*$/i);
  assert(versionMatch && Number.isSafeInteger(Number(versionMatch[1])), `Artifact queue card did not expose an exact version: ${selected.text}.`);
  const version = Number(versionMatch[1]);
  if (expectedVersion !== null) {
    assert(version === expectedVersion, `Expected submitted artifact v${expectedVersion}, observed v${version}.`);
  }
  const selectedUrl = new URL(selected.href);
  assert(selectedUrl.origin === context.adminOrigin && UUID_PATTERN.test(selectedUrl.searchParams.get('selected') || ''), `Artifact selection URL is not an exact local receipt: ${selected.href}.`);
  await navigate(connection, selectedUrl.href);
  await waitUntil(connection, `Array.from(document.querySelectorAll('h1,h2,h3,h4')).some((heading) => (heading.textContent || '').trim() === ${js(context.artifactTitle)})`, 'Admin did not load the exact selected artifact detail.', 30_000);
  assert(await evaluate(connection, `document.body.innerText.includes('version ${version}')`), `Admin detail did not preserve submitted artifact v${version}.`);
  assert(await evaluate(connection, `!document.body.innerText.includes('You submitted this artifact.')`), 'Artifact review is not independent from its contributor.');
  assert(await evaluate(connection, `document.body.innerText.includes('Byte-for-byte verified') && document.body.innerText.includes('Scripts, network, forms, frames, storage')`), 'Admin did not show the exact private-source and sanitizer receipts.');
  await waitUntil(connection, `document.querySelector('iframe[title="Independently sanitized static artifact preview"]')?.src.startsWith('blob:')`, 'Admin did not load and browser-verify the protected artifact bytes.', 30_000);
  const security = await evaluate(connection, `({
    sourceEscaped: document.body.innerText.includes('<section>') && document.body.innerText.includes('</section>'),
    previewSandbox: document.querySelector('iframe[title="Independently sanitized static artifact preview"]')?.getAttribute('sandbox') ?? null,
    previewReferrer: document.querySelector('iframe[title="Independently sanitized static artifact preview"]')?.getAttribute('referrerpolicy') ?? null,
    forbiddenFrame: Boolean(document.querySelector('iframe[srcdoc]')),
  })`);
  assert(security.sourceEscaped && security.previewSandbox === '' && security.previewReferrer === 'no-referrer' && !security.forbiddenFrame, `Admin artifact rendering boundary failed: ${JSON.stringify(security)}.`);
  return { selectedUrl, version, security };
}

async function runArtifactRequestChanges(context) {
  const { connection } = await primarySession(context.port);
  try {
    const selected = await openExactSubmittedArtifact(connection, context, 1);
    await fillNative(connection, '#artifact-review-reason', context.artifactReviewNote);
    await waitForButtonState(connection, 'Request changes', false, 30_000);
    await strictClickText(connection, 'Request changes');
    await waitUntil(connection, `(() => {
      const current = new URL(location.href);
      const exactCards = Array.from(document.querySelectorAll('a[href*="/review/html-artifacts"]')).filter((link) => (
        Array.from(link.querySelectorAll('p')).some((node) => (node.textContent || '').trim() === ${js(context.artifactTitle)})
      ));
      return current.origin === ${js(context.adminOrigin)} && current.pathname === '/review/html-artifacts' &&
        !current.searchParams.has('selected') && exactCards.length === 0;
    })()`, 'Admin did not record the artifact changes-requested transition.', 30_000);
    const output = await screenshot(connection, context.evidenceDirectory, '05-admin-artifact-changes-requested');
    await emitResult(context, {
      ok: true,
      command: 'artifact-request-changes',
      artifactTitle: context.artifactTitle,
      parentArtifactVersionId: selected.selectedUrl.searchParams.get('selected'),
      parentVersion: selected.version,
      reviewMessage: context.artifactReviewNote,
      security: selected.security,
      screenshot: output,
    });
  } finally { await connection.close(); }
}

async function runContributorReviseArtifact(context) {
  const { connection } = await primarySession(context.port);
  try {
    const fixtures = artifactFixtures(context);
    await navigate(connection, context.articleUrl);
    await openEditor(connection, context);
    await waitForButtonState(connection, 'Refresh status', false, 30_000);
    await strictClickText(connection, 'Refresh status');
    await waitUntil(connection, `(() => {
      const status = document.querySelector('[aria-label="Artifact review status"]')?.innerText || '';
      return status.includes(${js(context.artifactTitle)}) && status.includes(${js(context.artifactReviewNote)}) && status.toLowerCase().includes('changes requested');
    })()`, 'Contributor did not receive the exact artifact review feedback.', 30_000);

    const before = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(before.status === 200, `Artifact correction manifest returned ${before.status}.`);
    const baseReceipt = assertCurrentManifestEnvelope(before.body, context.slug);
    const proposalBefore = before.body.openProposal;
    assert(proposalBefore?.summary === context.summary && ['draft', 'changes_requested'].includes(proposalBefore.status), 'The exact contributor proposal is not open for artifact correction.');
    assert(Array.isArray(proposalBefore.artifacts) && proposalBefore.artifacts.length === 1, 'Artifact correction requires one exact reviewed parent request.');
    const parent = proposalBefore.artifacts[0];
    assert(parent.reviewState === 'changes_requested', `Expected changes_requested parent, observed ${parent.reviewState}.`);
    assert(parent.latestReviewMessage === context.artifactReviewNote, 'The manifest did not return the reviewer feedback byte-for-byte.');
    assert(parent.title === context.artifactTitle && parent.parentVersionId === null && parent.version === 1, 'The reviewed parent is not the exact original QA rendition.');
    assert(parent.sourceSha256 === sha256Text(fixtures.initial.html), 'The reviewed parent source hash does not match the staged QA source.');
    assert(parent.sourceBytes === Buffer.byteLength(fixtures.initial.html, 'utf8'), 'The reviewed parent source bytes do not match the staged QA source.');

    await strictClickText(connection, 'Revise');
    await waitUntil(connection, `document.querySelector('#artifact-dialog-title')?.textContent?.trim() === 'Revise static artifact'`, 'The reviewed artifact source editor did not open.', 30_000);
    const loaded = {
      title: await readExactLabelValue(connection, 'Title', 'input'),
      language: await readExactLabelValue(connection, 'Language', 'input'),
      description: await readExactLabelValue(connection, 'Short description', 'textarea'),
      licenceSpdx: await readExactLabelValue(connection, 'Licence / SPDX expression', 'input'),
      attribution: await readExactLabelValue(connection, 'Attribution', 'textarea'),
      sourceUrl: await readExactLabelValue(connection, 'Original source URL', 'input'),
      rightsHolder: await readExactLabelValue(connection, 'Rights holder', 'input'),
      provenance: await readExactLabelValue(connection, 'Provenance', 'textarea'),
      textFallback: await readExactLabelValue(connection, 'Text fallback', 'textarea'),
      html: await readExactLabelValue(connection, 'HTML and CSS', 'textarea'),
      thirdPartyAssetsDeclared: await readExactLabelCheckbox(connection, 'This artifact includes third-party images'),
      keyboardReviewed: await readExactLabelCheckbox(connection, 'Keyboard review completed'),
      screenReaderReviewed: await readExactLabelCheckbox(connection, 'Screen-reader review completed'),
      reducedMotionReviewed: await readExactLabelCheckbox(connection, 'Reduced-motion review completed'),
    };
    assert(loaded.title === parent.title && loaded.language === (parent.language ?? ''), 'Revise did not reload the reviewed source identity.');
    assert(loaded.description === parent.description && loaded.licenceSpdx === parent.licenceSpdx && loaded.attribution === parent.attribution, 'Revise did not reload the reviewed contributor metadata.');
    assert(loaded.sourceUrl === (parent.sourceUrl ?? '') && loaded.rightsHolder === parent.rightsHolder && loaded.provenance === parent.provenance, 'Revise did not reload the reviewed rights/provenance metadata.');
    assert(loaded.textFallback === parent.accessibility.textFallback && loaded.thirdPartyAssetsDeclared === parent.thirdPartyAssetsDeclared, 'Revise did not reload the reviewed accessibility/asset metadata.');
    assert(loaded.keyboardReviewed === parent.accessibility.keyboardReviewed && loaded.screenReaderReviewed === parent.accessibility.screenReaderReviewed && loaded.reducedMotionReviewed === parent.accessibility.reducedMotionReviewed, 'Revise did not reload the reviewed accessibility confirmations.');
    assert(loaded.html === fixtures.initial.html, 'Revise did not open with the exact reviewed private source bytes.');

    await fillExactLabel(connection, 'Short description', fixtures.corrected.description, 'textarea');
    await fillExactLabel(connection, 'Provenance', fixtures.corrected.provenance, 'textarea');
    await fillExactLabel(connection, 'Text fallback', fixtures.corrected.textFallback, 'textarea');
    await fillExactLabel(connection, 'HTML and CSS', fixtures.corrected.html, 'textarea');
    await setExactLabelCheckbox(connection, 'Keyboard review completed');
    await setExactLabelCheckbox(connection, 'Screen-reader review completed');
    await setExactLabelCheckbox(connection, 'Reduced-motion review completed');
    await setExactLabelCheckbox(connection, 'I confirm that I hold the rights');
    await setExactLabelCheckbox(connection, 'I accept the');
    await waitUntil(connection, `document.querySelector('#artifact-validation-status')?.textContent?.includes('Safe static preview ready.')`, 'Corrected artifact rendition did not validate.', 30_000);
    await waitUntil(connection, `document.querySelector('iframe[title^="Preview of"]')?.src.startsWith('blob:')`, 'Corrected artifact preview did not load its sanitized Blob receipt.', 30_000);
    const sandbox = await evaluate(connection, `(() => { const frame = document.querySelector('iframe[title^="Preview of"]'); return frame ? { sandbox: frame.getAttribute('sandbox'), referrer: frame.getAttribute('referrerpolicy'), src: frame.getAttribute('src') } : null; })()`);
    assert(sandbox && sandbox.sandbox === '' && sandbox.referrer === 'no-referrer' && !String(sandbox.src).startsWith('http'), `Corrected artifact preview sandbox is unsafe: ${JSON.stringify(sandbox)}.`);
    assert(await readExactLabelValue(connection, 'HTML and CSS', 'textarea') === fixtures.corrected.html, 'The validated editor source lost the exact correction marker.');
    const renderedCorrection = await evaluate(connection, `(async () => {
      const frame = document.querySelector('iframe[title^="Preview of"]');
      if (!frame?.src?.startsWith('blob:')) return null;
      const html = await (await fetch(frame.src, { cache: 'no-store' })).text();
      return {
        hasMarker: html.includes(${js(fixtures.corrected.marker)}),
        hasExecutableElement: /<(?:script|iframe|object|embed|form)\b/i.test(html),
      };
    })()`);
    assert(renderedCorrection?.hasMarker && !renderedCorrection.hasExecutableElement, `Corrected sanitized preview did not preserve the marker safely: ${JSON.stringify(renderedCorrection)}.`);

    await installArtifactRequestCapture(connection);
    await waitForButtonState(connection, 'Submit artifact for review', false, 30_000);
    await strictClickText(connection, 'Submit artifact for review');
    await waitUntil(connection, `(() => {
      const status = document.querySelector('[aria-label="Artifact review status"]')?.innerText || '';
      return !document.querySelector('#artifact-dialog-title') && status.includes(${js(context.artifactTitle)}) && status.includes('v2') && status.toLowerCase().includes('submitted');
    })()`, 'The corrected child artifact was not submitted.', 30_000);
    const capturedRequest = await takeArtifactRequestCapture(connection);
    const expected = expectedCorrectionSourceAndMetadata(parent, fixtures.corrected);
    assertExactArtifactCorrectionRequest(capturedRequest, {
      articleId: before.body.manifest.articleId,
      proposalId: proposalBefore.proposalId,
      proposalWorkflowVersion: proposalBefore.workflowVersion,
      baseReceipt,
      parent,
      ...expected,
    });

    const after = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(after.status === 200, `Corrected-child manifest returned ${after.status}.`);
    assertExactBaseReceipt(assertCurrentManifestEnvelope(after.body, context.slug), baseReceipt, 'Corrected-child proposal base receipt');
    const proposalAfter = after.body.openProposal;
    assert(proposalAfter?.summary === context.summary && ['draft', 'changes_requested'].includes(proposalAfter.status), 'The corrected child is no longer attached to the exact open proposal.');
    assert(Array.isArray(proposalAfter.artifacts) && proposalAfter.artifacts.length === 1, 'The parent and child both remained active at the reviewed coordinate.');
    assert(Array.isArray(proposalAfter.operations) && proposalAfter.operations.length === 2, 'Artifact correction changed the saved Markdown/typed operations.');
    const lineage = assertExactSubmittedArtifactChild(parent, proposalAfter.artifacts[0], capturedRequest, proposalBefore, proposalAfter);
    const output = await screenshot(connection, context.evidenceDirectory, '06-contributor-artifact-child-submitted');
    await emitResult(context, {
      ok: true,
      command: 'contributor-revise-artifact',
      editorContract: baseReceipt.editorContractVersion,
      proposalId: proposalAfter.proposalId,
      workflowVersion: proposalAfter.workflowVersion,
      reviewMessage: context.artifactReviewNote,
      correctionMarker: fixtures.corrected.marker,
      sourceSha256: proposalAfter.artifacts[0].sourceSha256,
      lineage,
      sandbox,
      renderedCorrection,
      screenshot: output,
    });
  } finally { await connection.close(); }
}

async function runArtifactApprove(context, options = {}) {
  const { connection } = await primarySession(context.port);
  try {
    const commandName = options.commandName ?? 'artifact-approve';
    const selected = await openExactSubmittedArtifact(connection, context, options.expectedVersion ?? null);
    await setExactLabelCheckbox(connection, 'Keyboard reviewed');
    await setExactLabelCheckbox(connection, 'Screen reader reviewed');
    await setExactLabelCheckbox(connection, 'Reduced motion reviewed');
    await waitForButtonState(connection, 'Approve exact rendition', false, 30_000);
    await strictClickText(connection, 'Approve exact rendition');
    await waitUntil(connection, `document.body.innerText.includes('Static artifact rendition approved and recorded.')`, 'Admin did not acknowledge the exact artifact approval.', 30_000);
    const output = await screenshot(connection, context.evidenceDirectory, options.expectedVersion ? '07-admin-artifact-child-approved' : '05-admin-artifact-approved');
    await emitResult(context, {
      ok: true,
      command: commandName,
      artifactTitle: context.artifactTitle,
      artifactVersionId: selected.selectedUrl.searchParams.get('selected'),
      version: selected.version,
      security: selected.security,
      screenshot: output,
    });
  } finally { await connection.close(); }
}

async function runContributorSubmit(context, options = {}) {
  const { connection } = await primarySession(context.port);
  try {
    const commandName = options.commandName ?? 'contributor-submit';
    await navigate(connection, context.articleUrl);
    await openEditor(connection, context);
    const before = await manifestResponse(connection, context.libraryOrigin, context.slug);
    const baseReceipt = assertCurrentManifestEnvelope(before.body, context.slug);
    assert(before.body.openProposal?.status === 'draft' && before.body.openProposal?.summary === context.summary, 'The exact staged draft is unavailable.');
    await strictClickText(connection, 'Refresh status');
    await waitUntil(connection, `document.querySelector('[aria-label="Artifact review status"]')?.innerText.toLowerCase().includes('approved')`, 'Contributor did not receive the approved artifact receipt.', 30_000);
    const approved = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(approved.status === 200 && approved.body.openProposal?.proposalId === before.body.openProposal.proposalId, 'The approved artifact receipt is no longer attached to the exact proposal.');
    const approvedArtifacts = approved.body.openProposal.artifacts;
    assert(Array.isArray(approvedArtifacts) && approvedArtifacts.length === 1 && approvedArtifacts[0].reviewState === 'approved', 'The exact approved artifact receipt is unavailable.');
    if (options.requireCorrectedArtifact) {
      const corrected = approvedArtifacts[0];
      const fixture = artifactFixtures(context).corrected;
      assert(corrected.version === 2 && UUID_PATTERN.test(corrected.parentVersionId || ''), 'Combined submission did not retain the exact approved child lineage.');
      assert(corrected.sourceSha256 === sha256Text(fixture.html) && corrected.sourceBytes === Buffer.byteLength(fixture.html, 'utf8'), 'Combined submission did not retain the corrected source receipt.');
      assert(corrected.description === fixture.description && corrected.provenance === fixture.provenance && corrected.accessibility?.textFallback === fixture.textFallback, 'Combined submission did not retain the corrected metadata.');
    }
    await openComposer(connection);
    const metadata = await evaluate(connection, `(() => ({
      summary: document.querySelector('textarea[placeholder="What did you improve, and why?"]')?.value,
      attribution: document.querySelector('aside[role="dialog"] input:not([type="checkbox"])')?.value,
      artifact: document.body.innerText.includes(${js(context.artifactTitle)}),
    }))()`);
    assert(metadata.summary === context.summary && metadata.attribution === context.attribution && metadata.artifact, 'The combined proposal lost contributor metadata or the approved artifact.');
    await setDialogCheckbox(connection, 1, true);
    await waitForButtonState(connection, 'Submit for review', false);
    await strictClickText(connection, 'Submit for review');
    await waitUntil(connection, `!document.querySelector('#library-proposal-title') && document.body.innerText.includes('Submitted for review')`, 'Proposal submission did not complete.', 30_000);
    const submitted = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(submitted.body.openProposal?.status === 'submitted', 'Submitted proposal is missing from the manifest.');
    assertExactBaseReceipt(assertCurrentManifestEnvelope(submitted.body, context.slug), baseReceipt, 'Submitted proposal base receipt');
    assert(submitted.body.openProposal.operations?.length === 2 && submitted.body.openProposal.artifacts?.every((artifact) => artifact.reviewState === 'approved'), 'Submitted v5 proposal lost text or approved artifact operations.');
    if (options.requireCorrectedArtifact) {
      const [artifact] = submitted.body.openProposal.artifacts;
      assert(artifact.version === 2 && UUID_PATTERN.test(artifact.parentVersionId || ''), 'Submitted combined proposal lost the approved child lineage.');
    }
    const output = await screenshot(connection, context.evidenceDirectory, options.requireCorrectedArtifact ? '08-contributor-submitted-corrected-v5' : '06-contributor-submitted-v5');
    await emitResult(context, {
      ok: true,
      command: commandName,
      editorContract: baseReceipt.editorContractVersion,
      proposalId: submitted.body.openProposal.proposalId,
      workflowVersion: submitted.body.openProposal.workflowVersion,
      artifactVersionId: submitted.body.openProposal.artifacts[0]?.artifactVersionId,
      artifactParentVersionId: submitted.body.openProposal.artifacts[0]?.parentVersionId,
      screenshot: output,
    });
  } finally { await connection.close(); }
}

async function readAdminDossier(connection) {
  return evaluate(connection, `(() => {
    const closestSectionForExactHeading = (text) => {
      const heading = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).find((candidate) => (
        (candidate.textContent || '').trim() === text
      ));
      return heading?.closest('section') || null;
    };
    const dossierSection = closestSectionForExactHeading('Proposal dossier');
    const validationSection = closestSectionForExactHeading('Validation report');
    const metadata = Object.fromEntries(Array.from(dossierSection?.querySelectorAll('dt') || []).map((term) => [
      (term.textContent || '').trim(),
      (term.nextElementSibling?.textContent || '').trim(),
    ]));
    const directSummary = Array.from(dossierSection?.children || []).find((child) => child.matches('p'));
    let report = null;
    try { report = JSON.parse(validationSection?.querySelector('pre')?.textContent || 'null'); } catch {}
    return {
      metadata,
      report,
      summary: (directSummary?.textContent || '').trim(),
      dossierFound: Boolean(dossierSection),
      validationFound: Boolean(validationSection),
    };
  })()`);
}

async function openAdminProposal(connection, context, filter = 'submitted') {
  const url = `${context.adminOrigin}/review/library-edits?filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(context.summary)}`;
  await navigate(connection, url);
  await waitUntil(connection, `document.body.innerText.includes('Review Library edits')`, 'Admin Library review page did not load.', 30_000);
  await waitUntil(connection, `document.body.innerText.includes(${js(context.summary)})`, 'The QA proposal was not found in the Admin queue.', 30_000);
  await waitUntil(connection, `document.body.innerText.includes('Proposal dossier')`, 'The QA proposal dossier did not load.', 30_000);
  const dossier = await readAdminDossier(connection);
  assert(dossier.dossierFound && dossier.validationFound, 'Admin did not expose the exact dossier and validation sections.');
  assert(dossier.summary === context.summary, `Admin selected the wrong proposal summary: ${dossier.summary}.`);
  assert(dossier.metadata['Editor contract'] === CURRENT_EDITOR_CONTRACT, `Admin rendered stale editor contract ${dossier.metadata['Editor contract']}.`);
  assert(UUID_PATTERN.test(dossier.metadata['Base revision'] || ''), 'Admin base revision receipt is not a UUID.');
  assert(LOWER_GIT_SHA_PATTERN.test(dossier.metadata['Base Git blob'] || ''), 'Admin base Git blob receipt is invalid.');
  assert(LOWER_SHA256_PATTERN.test(dossier.metadata['Base content SHA-256'] || ''), 'Admin base content receipt is invalid.');
  assert(LOWER_SHA256_PATTERN.test(dossier.metadata['Proposed content SHA-256'] || ''), 'Admin proposed content receipt is invalid.');
  assert(dossier.report?.valid === true && dossier.report?.editor_contract_version === CURRENT_EDITOR_CONTRACT, 'Admin validation report is not a valid v5 receipt.');
  assert(dossier.report.base_content_sha256 === dossier.metadata['Base content SHA-256'], 'Admin validation report/base content SHA mismatch.');
  assert(dossier.report.base_git_blob_sha === dossier.metadata['Base Git blob'], 'Admin validation report/base Git blob mismatch.');
  assert(dossier.report.result_content_sha256 === dossier.metadata['Proposed content SHA-256'], 'Admin validation report/proposed content SHA mismatch.');
  assert(Number.isSafeInteger(dossier.report.operation_count) && dossier.report.operation_count > 0, 'Admin validation report has no operations.');
  return dossier;
}

async function runAdminSelfReview(context) {
  const { connection } = await primarySession(context.port);
  try {
    const dossier = await openAdminProposal(connection, context);
    const state = await assertButton(connection, 'Request changes', true);
    assert(state.title.includes('cannot review your own proposal'), `Self-review denial reason is missing: ${state.title}`);
    await assertButton(connection, 'Add comment', true);
    const output = await screenshot(connection, context.evidenceDirectory, '07-admin-self-review-denied');
    await emitResult(context, { ok: true, command: 'admin-self-review', editorContract: dossier.metadata['Editor contract'], screenshot: output });
  } finally { await connection.close(); }
}

async function adminHistoryEventCount(connection, eventLabel, message) {
  return evaluate(connection, `(() => {
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).find((candidate) => (
      (candidate.textContent || '').trim() === 'Review and publication history'
    ));
    const section = heading?.closest('section');
    if (!section) return -1;
    return Array.from(section.querySelectorAll('li')).filter((item) => {
      const hasEvent = Array.from(item.querySelectorAll('div')).some((node) => (
        node.children.length === 0 && (node.textContent || '').trim().toLowerCase() === ${js(eventLabel.toLowerCase())}
      ));
      const hasMessage = Array.from(item.querySelectorAll('p')).some((node) => (
        (node.textContent || '').trim() === ${js(message)}
      ));
      return hasEvent && hasMessage;
    }).length;
  })()`);
}

async function waitForAdminHistoryEventCount(connection, eventLabel, message, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let count = -1;
  while (Date.now() < deadline) {
    count = await adminHistoryEventCount(connection, eventLabel, message);
    if (count === expected) return count;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Admin history ${eventLabel}/${message} count was ${count}, expected ${expected}.`);
}

async function waitForAdminHistoryReady(connection, eventLabel, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let count = -1;
  while (Date.now() < deadline) {
    count = await adminHistoryEventCount(connection, eventLabel, message);
    if (count >= 0) return count;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error('Admin review history did not become available.');
}

async function runAdminRequestChanges(context) {
  const { connection } = await primarySession(context.port);
  try {
    const dossier = await openAdminProposal(connection, context);
    assert(await evaluate(connection, `document.body.innerText.includes('The validation receipt matches the article path, current editor contract, operations and immutable hashes.')`), 'Admin did not show a valid immutable receipt.');
    assert(await evaluate(connection, `document.body.innerText.includes(${js(context.probe)})`), 'Admin exact diff omitted the proposed Markdown marker.');
    assert(await evaluate(connection, `document.body.innerText.includes('Live Library delivery')`), 'Admin did not expose the current live-delivery review lane.');
    const before = await screenshot(connection, context.evidenceDirectory, '08-admin-review-dossier');

    const existingCommentCount = await waitForAdminHistoryReady(connection, 'review comment', QA_REVIEW_COMMENT);
    assert(existingCommentCount >= 0 && existingCommentCount <= 1, `Expected at most one exact QA reviewer comment, observed ${existingCommentCount}.`);
    if (existingCommentCount === 0) {
      await fillNative(connection, '#library-review-message', QA_REVIEW_COMMENT);
      await waitForButtonState(connection, 'Add comment', false);
      await strictClickText(connection, 'Add comment');
      await waitUntil(connection, `document.body.innerText.includes('Review comment added.')`, 'Review comment was not acknowledged.', 30_000);
      await waitForAdminHistoryEventCount(connection, 'review comment', QA_REVIEW_COMMENT, 1, 30_000);
    }
    await fillNative(connection, '#library-review-message', context.reviewNote);
    await waitForButtonState(connection, 'Request changes', false);
    await strictClickText(connection, 'Request changes');
    await waitUntil(connection, `document.body.innerText.includes('Changes requested from the contributor.')`, 'Request-changes action was not acknowledged.', 30_000);
    await waitUntil(connection, `document.body.innerText.toLowerCase().includes('changes requested')`, 'Proposal status did not become changes requested.', 30_000);
    const after = await screenshot(connection, context.evidenceDirectory, '09-admin-requested-changes');
    await emitResult(context, { ok: true, command: 'admin-request-changes', editorContract: dossier.metadata['Editor contract'], baseRevisionId: dossier.metadata['Base revision'], reviewerComment: existingCommentCount === 1 ? 'reused-existing-exact-comment' : 'added-once', screenshots: [before, after] });
  } finally { await connection.close(); }
}

async function runContributorFeedback(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    await openEditor(connection, context);
    await waitUntil(connection, `document.body.innerText.includes('Changes requested') && document.body.innerText.includes(${js(context.reviewNote)})`, 'Contributor feedback did not appear.');
    await openComposer(connection);
    const restored = await evaluate(connection, `(() => {
      const dialog = document.querySelector('aside[role="dialog"]');
      return {
        summary: dialog?.querySelector('textarea[placeholder="What did you improve, and why?"]')?.value,
        attribution: dialog?.querySelector('input:not([type="checkbox"])')?.value,
      };
    })()`);
    assert(restored.summary === context.summary && restored.attribution === context.attribution, 'Feedback reopening lost contributor metadata.');
    const output = await screenshot(connection, context.evidenceDirectory, '10-contributor-feedback');
    await emitResult(context, { ok: true, command: 'contributor-feedback', screenshot: output });
  } finally { await connection.close(); }
}

async function createTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  assert(response.ok, `CDP could not create a second tab: HTTP ${response.status}.`);
  return response.json();
}

async function prepareConcurrentDraft(connection, context, marker) {
  await openEditor(connection, context);
  const { manifest } = await editableContext(connection, context.libraryOrigin, context.slug);
  const blockId = manifest.manifest.blocks.find((block) => block.editMode === 'markdown' && block.blockKind === 'paragraph')?.blockId;
  assert(blockId, 'The concurrency canary has no Markdown paragraph block.');
  await strictClickSelector(connection, `button[data-ls-edit-trigger=${js(blockId)}]`);
  await waitUntil(connection, `Boolean(document.querySelector('#library-block-editor-title'))`, 'Concurrent paragraph editor did not open.');
  const current = await evaluate(connection, `document.querySelector('#library-proposed-content')?.value || ''`);
  const proposed = `${current} ${marker}`;
  await fillNative(connection, '#library-proposed-content', proposed);
  await waitForButtonState(connection, 'Add to proposal', false);
  await strictClickText(connection, 'Add to proposal');
  await openComposer(connection);
  const summary = await evaluate(connection, `document.querySelector('textarea[placeholder="What did you improve, and why?"]')?.value || ''`);
  if (!summary.trim()) await fillNative(connection, 'textarea[placeholder="What did you improve, and why?"]', context.summary);
  return { blockId, proposed };
}

async function waitForWorkflowAdvance(connection, context, proposalId, startingVersion, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await manifestResponse(connection, context.libraryOrigin, context.slug);
    const proposal = last.body?.openProposal;
    if (
      last.status === 200 &&
      proposal?.proposalId === proposalId &&
      Number.isSafeInteger(proposal.workflowVersion) &&
      proposal.workflowVersion > startingVersion
    ) return last;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Winning save did not advance workflow ${proposalId} beyond ${startingVersion}; last status/version ${last?.status}/${last?.body?.openProposal?.workflowVersion}.`);
}

async function runStaleConcurrency(context) {
  const first = await primarySession(context.port);
  let secondConnection;
  try {
    await navigate(first.connection, context.articleUrl);
    const secondTarget = await createTarget(context.port, context.articleUrl);
    secondConnection = await connectTarget(secondTarget);
    await waitUntil(secondConnection, `document.readyState === 'complete'`, 'Second contributor tab did not load.', 30_000);

    const firstManifest = await manifestResponse(first.connection, context.libraryOrigin, context.slug);
    const secondManifest = await manifestResponse(secondConnection, context.libraryOrigin, context.slug);
    assert(firstManifest.status === 200 && secondManifest.status === 200, 'Concurrent tabs could not read the signed manifest.');
    const firstBaseReceipt = assertCurrentManifestEnvelope(firstManifest.body, context.slug);
    const secondBaseReceipt = assertCurrentManifestEnvelope(secondManifest.body, context.slug);
    assertExactBaseReceipt(secondBaseReceipt, firstBaseReceipt, 'Concurrent tab base receipt');
    assert(firstManifest.body.openProposal?.proposalId === secondManifest.body.openProposal?.proposalId, 'Concurrent tabs do not reference the same proposal.');
    assert(firstManifest.body.openProposal?.workflowVersion === secondManifest.body.openProposal?.workflowVersion, 'Concurrent tabs did not start from one workflow version.');
    assert(firstManifest.body.openProposal?.proposalId && Number.isSafeInteger(firstManifest.body.openProposal?.workflowVersion), 'Concurrent tabs have no mutable proposal/workflow receipt.');
    const proposalId = firstManifest.body.openProposal.proposalId;
    const startingVersion = firstManifest.body.openProposal.workflowVersion;

    const firstEdit = await prepareConcurrentDraft(first.connection, context, 'Concurrent winner A.');
    const secondEdit = await prepareConcurrentDraft(secondConnection, context, 'Concurrent loser B.');
    await strictClickText(first.connection, 'Save draft');
    const winner = await waitForWorkflowAdvance(first.connection, context, proposalId, startingVersion);
    assert(winner.body.openProposal.workflowVersion === startingVersion + 1, 'One winning save did not advance workflow by exactly one CAS version.');
    assertExactBaseReceipt(assertCurrentManifestEnvelope(winner.body, context.slug), firstBaseReceipt, 'Winning save base receipt');
    assert(winner.body.openProposal.operations.some((operation) => operation.proposed_fragment === firstEdit.proposed), 'Winning edit was not persisted.');

    await strictClickText(secondConnection, 'Save draft');
    await waitUntil(secondConnection, `document.body.innerText.includes('The proposal changed. Refresh it before trying again.')`, 'Stale concurrent save did not fail explicitly.', 30_000);
    const observed = await manifestResponse(secondConnection, context.libraryOrigin, context.slug);
    assert(observed.body.openProposal.workflowVersion === winner.body.openProposal.workflowVersion, 'Stale tab did not observe the winning version.');
    assertExactBaseReceipt(assertCurrentManifestEnvelope(observed.body, context.slug), firstBaseReceipt, 'Stale tab post-race base receipt');
    assert(!observed.body.openProposal.operations.some((operation) => operation.proposed_fragment === secondEdit.proposed), 'Losing concurrent edit overwrote the winner.');
    const output = await screenshot(secondConnection, context.evidenceDirectory, '11-stale-concurrency-rejected');
    await emitResult(context, { ok: true, command: 'stale-concurrency', editorContract: firstBaseReceipt.editorContractVersion, proposalId, startingVersion, winningVersion: winner.body.openProposal.workflowVersion, screenshot: output });
  } finally {
    if (secondConnection) {
      await secondConnection.send('Page.close').catch(() => {});
      await secondConnection.close().catch(() => {});
    }
    await first.connection.close();
  }
}

async function runContributorResubmit(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    await openEditor(connection, context);
    await openComposer(connection);
    const metadata = await evaluate(connection, `(() => ({
      summary: document.querySelector('textarea[placeholder="What did you improve, and why?"]')?.value,
      attribution: document.querySelector('aside[role="dialog"] input:not([type="checkbox"])')?.value,
    }))()`);
    assert(metadata.summary === context.summary && metadata.attribution === context.attribution, 'Winning draft lost metadata before resubmission.');
    await setDialogCheckbox(connection, 1, true);
    await waitForButtonState(connection, 'Submit for review', false);
    await strictClickText(connection, 'Submit for review');
    await waitUntil(connection, `!document.querySelector('#library-proposal-title') && document.body.innerText.includes('Submitted for review')`, 'Resubmission did not complete.', 30_000);
    const resubmitted = await manifestResponse(connection, context.libraryOrigin, context.slug);
    assert(resubmitted.body.openProposal?.status === 'submitted', 'Resubmitted proposal is not in submitted state.');
    assert(resubmitted.body.openProposal.latestReviewMessage === null, 'Historical review feedback leaked into the resubmitted current state.');
    const output = await screenshot(connection, context.evidenceDirectory, '12-contributor-resubmitted');
    const baseReceipt = assertCurrentManifestEnvelope(resubmitted.body, context.slug);
    await emitResult(context, { ok: true, command: 'contributor-resubmit', editorContract: baseReceipt.editorContractVersion, workflowVersion: resubmitted.body.openProposal.workflowVersion, screenshot: output });
  } finally { await connection.close(); }
}

async function runAdminActivate(context) {
  const { connection } = await primarySession(context.port);
  try {
    const dossier = await openAdminProposal(connection, context, 'submitted');
    assert(await evaluate(connection, `document.body.innerText.includes(${js(context.probe)}) && document.body.innerText.includes(${js(context.artifactTitle)})`), 'Admin activation dossier is missing reviewed text or artifact evidence.');
    assert(await evaluate(connection, `document.body.innerText.includes('Exact private preview receipt') && document.body.innerText.includes('Proposal mode')`), 'The trusted render payload/preview receipt is unavailable.');
    const preview = await evaluate(connection, `Array.from(document.querySelectorAll('a')).find((link) => (link.textContent || '').includes('Open role-protected preview'))?.href || null`);
    const previewUrl = preview ? new URL(preview) : null;
    assert(previewUrl && previewUrl.origin === context.libraryOrigin && /^\/api\/library\/live-preview\/[0-9a-f-]+$/i.test(previewUrl.pathname), `The role-protected preview URL is not the isolated Library receipt: ${preview}.`);
    await fillNative(connection, '#library-live-delivery-reason', context.liveReason);
    await waitForButtonState(connection, 'Activate dynamic content', false, 30_000);
    await strictClickText(connection, 'Activate dynamic content');
    await waitUntil(connection, `document.body.innerText.includes('Dynamic content activated and queued for public verification.') || document.body.innerText.includes('This exact activation was already committed')`, 'Admin did not acknowledge the exact dynamic activation.', 60_000);
    const output = await screenshot(connection, context.evidenceDirectory, '10-admin-dynamic-activated');
    await emitResult(context, { ok: true, command: 'admin-activate', editorContract: dossier.metadata['Editor contract'], preview, screenshot: output });
  } finally { await connection.close(); }
}

async function runSecurityBoundaries(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    const worker = await pageFetch(connection, `${context.libraryOrigin}/api/library/public-delivery-worker`, { method: 'POST' });
    assert(worker.status === 401 && errorCode(worker) === 'public_delivery_worker_unauthorized', `Unauthenticated worker returned ${worker.status}/${errorCode(worker)}.`);
    const hostile = await pageFetch(connection, `${context.libraryOrigin}/api/library/artifacts/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hostile QA artifact', language: 'en', html: '<script>window.__lovelaceQaArtifactExecuted=true</script><iframe srcdoc="<script>alert(1)</script>"></iframe>' }),
    });
    assert(hostile.status === 422 && hostile.body?.ok === false && Array.isArray(hostile.body?.diagnostics), `Hostile artifact validation returned ${hostile.status}/${JSON.stringify(hostile.body).slice(0, 500)}.`);
    assert(await evaluate(connection, `window.__lovelaceQaArtifactExecuted !== true && !document.querySelector('iframe[srcdoc]')`), 'Hostile validation input reached an executable page sink.');
    await emitResult(context, {
      ok: true,
      command: 'security-boundaries',
      workerBoundary: { status: worker.status, code: errorCode(worker) },
      artifactBoundary: { status: hostile.status, diagnosticCodes: hostile.body.diagnostics.map((item) => item.code).slice(0, 20) },
    });
  } finally { await connection.close(); }
}

async function fetchPublicConvergence(connection, context) {
  return evaluate(connection, `(async () => {
    const origin = ${js(context.libraryOrigin)};
    const slug = ${js(context.slug)};
    const probe = ${js(context.probe)};
    const get = async (pathname, accept) => {
      const response = await fetch(new URL(pathname, origin), { cache: 'no-store', headers: { accept } });
      const text = await response.text();
      return { status: response.status, text, headers: Object.fromEntries(response.headers.entries()) };
    };
    const deliveryResult = await get('/api/library/content-delivery/' + slug, 'application/json');
    const delivery = deliveryResult.status === 200 ? JSON.parse(deliveryResult.text) : null;
    const revision = delivery?.article?.published_revision_id;
    const generation = delivery?.article?.publication_generation;
    const immutablePath = delivery?.article?.immutable_markdown_url;
    if (delivery?.delivery_mode !== 'live' || !revision || !Number.isSafeInteger(generation) || !immutablePath) {
      return { converged: false, stage: 'delivery-manifest', delivery };
    }
    const [page, markdown, immutable, catalogResult, searchResult, llmsFull, sitemap] = await Promise.all([
      get('/' + slug, 'text/html'),
      get('/llms.mdx/docs/' + slug + '/content.md', 'text/markdown'),
      get(immutablePath, 'text/markdown'),
      get('/llms.json', 'application/json'),
      get('/api/search?query=' + encodeURIComponent(probe), 'application/json'),
      get('/llms-full.txt', 'text/plain'),
      get('/sitemap.xml', 'application/xml'),
    ]);
    if ([page, markdown, immutable, catalogResult, searchResult, llmsFull, sitemap].some((result) => result.status !== 200)) {
      return { converged: false, stage: 'http', statuses: [page.status, markdown.status, immutable.status, catalogResult.status, searchResult.status, llmsFull.status, sitemap.status] };
    }
    const catalog = JSON.parse(catalogResult.text);
    const article = catalog.pages?.find((candidate) => candidate.path === slug);
    const search = JSON.parse(searchResult.text);
    const searchProbe = Array.isArray(search) && search.some((row) => {
      try { return new URL(String(row.url || ''), origin).pathname === '/' + slug && String(row.content || '').replace(/<\\/?mark>/gi, '').includes(probe); }
      catch { return false; }
    });
    const exactReceipts = article?.published_revision_id === revision && article?.publication_generation === generation &&
      article?.content_sha256 === delivery.article.content_sha256 && article?.payload_sha256 === delivery.article.payload_sha256;
    const textConverged = page.text.includes(probe) && markdown.text.includes(probe) && immutable.text.includes(probe) && llmsFull.text.includes(probe) && searchProbe;
    const artifactConverged = page.text.includes(${js(context.artifactTitle)}) && markdown.text.includes(${js(context.artifactTitle)});
    const jsonLd = /<script[^>]+application\\/ld\\+json/i.test(page.text);
    return {
      converged: Boolean(exactReceipts && textConverged && artifactConverged && jsonLd && sitemap.text.includes('/' + slug)),
      stage: 'complete', revision, generation,
      contentSha256: delivery.article.content_sha256,
      payloadSha256: delivery.article.payload_sha256,
      exactReceipts, textConverged, artifactConverged, jsonLd,
    };
  })()`);
}

async function runPublicConvergence(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    const deadline = Date.now() + 90_000;
    let receipt = null;
    while (Date.now() < deadline) {
      receipt = await fetchPublicConvergence(connection, context);
      if (receipt?.converged) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert(receipt?.converged, `Public delivery did not converge: ${JSON.stringify(receipt)}.`);
    await reload(connection);
    await waitUntil(connection, `document.body.innerText.includes(${js(context.probe)})`, 'Reloaded article omitted the activated text.');
    const output = await screenshot(connection, context.evidenceDirectory, '11-public-convergence');
    await emitResult(context, { ok: true, command: 'public-convergence', ...receipt, screenshot: output });
  } finally { await connection.close(); }
}

const DELIVERY_SURFACE_LABELS = [
  'Cache invalidation', 'Article HTML', 'Article Markdown', 'Catalog', 'Search',
  'LLM corpus', 'Sitemap', 'JSON-LD', 'Delivery manifest', 'Ada',
];

async function readAdminDeliveryMatrix(connection) {
  return evaluate(connection, `(() => {
    const heading = Array.from(document.querySelectorAll('h3')).find((node) => (node.textContent || '').trim() === 'Live Library delivery');
    const panel = heading?.closest('section');
    const table = Array.from(panel?.querySelectorAll('table') || []).find((candidate) => (
      Array.from(candidate.querySelectorAll('th')).map((cell) => (cell.textContent || '').trim()).join('|').startsWith('Surface|State|Endpoint|Revision receipt')
    ));
    return {
      published: Array.from(panel?.querySelectorAll('*') || []).some((node) => node.children.length === 0 && (node.textContent || '').trim() === 'Published'),
      rows: Array.from(table?.querySelectorAll('tbody tr') || []).map((row) => ({
      surface: (row.children[0]?.textContent || '').trim(),
      state: (row.children[1]?.textContent || '').trim(),
      endpoint: (row.children[2]?.textContent || '').trim(),
      revision: (row.children[3]?.textContent || '').trim(),
      })),
    };
  })()`);
}

async function runAdminConvergence(context) {
  const { connection } = await primarySession(context.port);
  try {
    const deadline = Date.now() + 90_000;
    let matrix = null;
    while (Date.now() < deadline) {
      await openAdminProposal(connection, context, 'approved');
      matrix = await readAdminDeliveryMatrix(connection);
      if (matrix.published && DELIVERY_SURFACE_LABELS.every((label) => matrix.rows.some((row) => row.surface === label && row.state === 'Verified'))) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert(matrix?.published, 'Admin never marked the current public-delivery job Published.');
    for (const label of DELIVERY_SURFACE_LABELS) {
      const row = matrix.rows.find((candidate) => candidate.surface === label);
      assert(
        row?.state === 'Verified' && row.endpoint && row.endpoint !== 'Not attempted' && row.revision && row.revision !== 'Not observed',
        `Delivery surface ${label} did not expose an exact verified receipt: ${JSON.stringify(row)}.`,
      );
    }
    const adaReceipt = matrix.rows.find((row) => row.surface === 'Ada');
    let adaEndpoint;
    try {
      adaEndpoint = new URL(adaReceipt.endpoint);
    } catch {
      throw new Error(`Ada did not expose an absolute local endpoint: ${JSON.stringify(adaReceipt)}.`);
    }
    assert(adaEndpoint.origin === context.adaOrigin, `Ada verification escaped the isolated origin: ${adaEndpoint.origin}.`);
    const output = await screenshot(connection, context.evidenceDirectory, '12-admin-all-surfaces-verified');
    await emitResult(context, { ok: true, command: 'admin-convergence', surfaces: matrix.rows, adaReceipt, screenshot: output });
  } finally { await connection.close(); }
}

async function runRetryDelivery(context) {
  const { connection } = await primarySession(context.port);
  try {
    await openAdminProposal(connection, context, 'approved');
    const state = await buttonState(connection, 'Retry public delivery');
    assert(state.found && !state.disabled, 'Retry requires a deliberately failed or retry-wait job in the disposable stack.');
    await fillNative(connection, '#library-live-delivery-reason', context.liveReason);
    await strictClickText(connection, 'Retry public delivery');
    await waitUntil(connection, `document.body.innerText.includes('Public-delivery retry queued.') || document.body.innerText.includes('This exact retry was already queued.')`, 'Admin did not acknowledge the exact retry receipt.', 60_000);
    const output = await screenshot(connection, context.evidenceDirectory, '13-delivery-retry-queued');
    await emitResult(context, { ok: true, command: 'retry-delivery', screenshot: output });
  } finally { await connection.close(); }
}

async function runRollback(context) {
  const { connection } = await primarySession(context.port);
  try {
    await navigate(connection, context.articleUrl);
    const before = await pageFetch(connection, `${context.libraryOrigin}/api/library/content-delivery/${context.slug}`);
    const beforeGeneration = before.body?.article?.publication_generation;
    assert(before.body?.delivery_mode === 'live' && Number.isSafeInteger(beforeGeneration), 'Rollback requires one current live activation.');
    await openAdminProposal(connection, context, 'approved');
    await fillNative(connection, '#library-live-delivery-reason', context.liveReason);
    const rollbackChoice = await evaluate(connection, `(() => {
      document.querySelectorAll('[data-ls-qa-rollback]').forEach((node) => node.removeAttribute('data-ls-qa-rollback'));
      const buttons = Array.from(document.querySelectorAll('button')).filter((button) => (
        (button.textContent || '').trim() === 'Publish append-only rollback' &&
        !button.disabled && !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true'
      ));
      const selected = buttons[0];
      selected?.setAttribute('data-ls-qa-rollback', '');
      return { count: buttons.length, context: selected?.closest('article')?.innerText?.slice(0, 500) || null };
    })()`);
    assert(rollbackChoice.count >= 1, `No compatible append-only rollback target is enabled: ${JSON.stringify(rollbackChoice)}.`);
    await strictClickSelector(connection, '[data-ls-qa-rollback]');
    await waitUntil(connection, `document.body.innerText.includes('A new rollback activation was committed') || document.body.innerText.includes('This exact append-only rollback was already committed')`, 'Admin did not acknowledge the append-only rollback.', 60_000);
    await navigate(connection, context.articleUrl);
    const deadline = Date.now() + 90_000;
    let after = null;
    let removed = false;
    while (Date.now() < deadline) {
      after = await pageFetch(connection, `${context.libraryOrigin}/api/library/content-delivery/${context.slug}`);
      if (Number.isSafeInteger(after.body?.article?.publication_generation) && after.body.article.publication_generation > beforeGeneration) {
        await reload(connection);
        removed = await evaluate(connection, `!document.body.innerText.includes(${js(context.probe)}) && !document.body.innerText.includes(${js(context.artifactTitle)})`);
        if (removed) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert(after?.body?.article?.publication_generation > beforeGeneration, 'Rollback did not create a higher publication generation.');
    assert(removed, 'Rollback did not remove the canary content from public HTML.');
    const output = await screenshot(connection, context.evidenceDirectory, '14-append-only-rollback');
    await emitResult(context, { ok: true, command: 'rollback', beforeGeneration, afterGeneration: after.body.article.publication_generation, activationId: after.body.article.activation_id, selectedTarget: rollbackChoice.context, screenshot: output });
  } finally { await connection.close(); }
}

async function runMobile(context, flags) {
  const surface = option(flags, 'surface', 'library');
  const url = surface === 'admin'
    ? `${context.adminOrigin}/review/library-edits?filter=submitted&q=${encodeURIComponent(context.summary)}`
    : context.articleUrl;
  const { connection } = await primarySession(context.port);
  try {
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await navigate(connection, url);
    await waitUntil(connection, `document.readyState === 'complete'`, 'Mobile page did not settle.', 30_000);
    if (surface === 'admin') {
      await waitUntil(
        connection,
        `document.body.innerText.includes('Review Library edits') && document.body.innerText.includes(${js(context.summary)}) && document.body.innerText.includes('Proposal dossier')`,
        'Mobile Admin check did not reach the selected QA proposal.',
        30_000,
      );
    } else {
      await waitUntil(
        connection,
        `location.pathname === ${js(`/${context.slug}`)} && document.querySelector('h1') && document.querySelectorAll('button[data-ls-edit-trigger]').length > 0`,
        'Mobile Library check did not render the canary article.',
        30_000,
      );
    }
    const layout = await evaluate(connection, `({ innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, hasSrcdoc: Boolean(document.querySelector('iframe[srcdoc]')) })`);
    assert(layout.scrollWidth <= layout.innerWidth + 2 && layout.bodyWidth <= layout.innerWidth + 2, `Mobile page overflows horizontally: ${JSON.stringify(layout)}`);
    assert(!layout.hasSrcdoc, 'Mobile surface rendered a forbidden srcdoc frame.');
    const output = await screenshot(connection, context.evidenceDirectory, `15-mobile-${surface}`);
    await emitResult(context, { ok: true, command: 'mobile', surface, layout, screenshot: output }, surface);
  } finally {
    await connection.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await connection.close();
  }
}

async function closeBrowser(context) {
  const { port } = context;
  const version = await fetchVersion({ port });
  assert(version.webSocketDebuggerUrl, 'Browser-level CDP endpoint is unavailable.');
  const connection = new CdpConnection(version.webSocketDebuggerUrl);
  await connection.connect();
  await connection.send('Browser.close');
  await emitResult(context, { ok: true, command: 'close-browser', port });
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];
if (!command || command === 'help') {
  usage();
  process.exit(command ? 0 : 1);
}

const port = numberOption(flags, 'port', 9333);
const libraryOrigin = loopbackOrigin(option(flags, 'library', DEFAULT_LIBRARY_ORIGIN), 'Library origin');
const adminOrigin = loopbackOrigin(option(flags, 'admin', DEFAULT_ADMIN_ORIGIN), 'Admin origin');
const adaOrigin = loopbackOrigin(option(flags, 'ada', DEFAULT_ADA_ORIGIN), 'Ada origin');
const slug = option(flags, 'slug', DEFAULT_SLUG).replace(/^\/+|\/+$/g, '');
assert(/^[a-z0-9][a-z0-9/_-]{0,500}$/i.test(slug) && !slug.includes('..') && !slug.includes('//'), 'The article slug is invalid.');
const evidenceDirectory = privateEvidenceDirectory(option(
  flags,
  'evidence',
  process.env.LOVELACE_QA_EVIDENCE || path.join(os.homedir(), '.lovelace', 'qa-evidence', 'library-editing-20260718'),
));
const summary = option(flags, 'summary', process.env.LOVELACE_QA_SUMMARY || DEFAULT_SUMMARY).trim();
const probe = option(flags, 'probe', DEFAULT_PROBE).trim();
const artifactReviewNote = option(flags, 'artifact-review-note', DEFAULT_ARTIFACT_REVIEW_NOTE).trim();
const liveReason = option(flags, 'live-reason', DEFAULT_LIVE_REASON).trim();
assert(summary.length > 0 && summary.length <= 2_000, 'The QA summary must contain 1-2000 characters.');
assert(probe.length >= 8 && probe.length <= 160 && !/[<>\r\n]/.test(probe), 'The convergence probe must be 8-160 plain-text characters.');
assert(artifactReviewNote.length > 0 && artifactReviewNote.length <= 4_000, 'The artifact review note must contain 1-4000 characters.');
assert(liveReason.length > 0 && liveReason.length <= 2_000, 'The live-delivery reason must contain 1-2000 characters.');
const context = {
  port,
  libraryOrigin,
  adminOrigin,
  adaOrigin,
  slug,
  articleUrl: `${libraryOrigin}/${slug}`,
  evidenceDirectory,
  summary,
  probe,
  artifactReviewNote,
  artifactTitle: `${summary} artifact`.slice(0, 160),
  attribution: option(flags, 'attribution', DEFAULT_ATTRIBUTION),
  reviewNote: option(flags, 'review-note', DEFAULT_REVIEW_NOTE),
  liveReason,
  profileLabel: safeEvidenceName(option(flags, 'profile-label', 'profile')) || 'profile',
  loginDestination: safeSameOriginPath(option(flags, 'login-destination', '/review/library-edits')),
};

const commands = {
  'self-test': () => runHarnessSelfTest(context),
  preflight: () => runPreflight(context),
  'local-login': () => runLocalLogin(context),
  'editor-auth-smoke': () => runEditorAuthSmoke(context),
  'signed-out': () => runSignedOut(context),
  'expect-manifest-error': () => runExpectManifestError(context, flags),
  'role-denied': () => runRoleDenied(context),
  'withdraw-open-draft': () => runWithdrawOpenDraft(context),
  'contributor-stage': () => runContributorStage(context),
  'artifact-approve': () => runArtifactApprove(context),
  'artifact-request-changes': () => runArtifactRequestChanges(context),
  'contributor-revise-artifact': () => runContributorReviseArtifact(context),
  'artifact-approve-child': () => runArtifactApprove(context, { expectedVersion: 2, commandName: 'artifact-approve-child' }),
  'contributor-submit': () => runContributorSubmit(context),
  'contributor-submit-corrected': () => runContributorSubmit(context, { requireCorrectedArtifact: true, commandName: 'contributor-submit-corrected' }),
  'admin-self-review': () => runAdminSelfReview(context),
  'admin-request-changes': () => runAdminRequestChanges(context),
  'contributor-feedback': () => runContributorFeedback(context),
  'stale-concurrency': () => runStaleConcurrency(context),
  'contributor-resubmit': () => runContributorResubmit(context),
  'admin-activate': () => runAdminActivate(context),
  'public-convergence': () => runPublicConvergence(context),
  'admin-convergence': () => runAdminConvergence(context),
  'retry-delivery': () => runRetryDelivery(context),
  rollback: () => runRollback(context),
  'security-boundaries': () => runSecurityBoundaries(context),
  mobile: () => runMobile(context, flags),
  'close-browser': () => closeBrowser(context),
};

assert(commands[command], `Unknown command: ${command}`);
await commands[command]();
