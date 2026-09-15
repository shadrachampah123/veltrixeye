/**
 * M6 Phase 4 — shared UI primitive render tests.
 *
 * These cover the three primitives the review asked for:
 *  - `Alert` must be able to announce itself as a live region (`role="status"`
 *    for ordinary async outcomes, `role="alert"` for errors that interrupt),
 *    while staying byte-identical to before when no role is requested;
 *  - `Spinner` must name what is loading, so a blank screen has an
 *    announcement instead of a silent one;
 *  - `LinkButton` must render a real `<a>` (never a `<button>` nested in an
 *    `<a>`) yet look identical to `Button`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Alert, Button, LinkButton, Spinner, buttonClass } from '../components/ui';

test('Alert — opt-in live-region roles, unchanged markup when omitted', () => {
  const status = renderToStaticMarkup(React.createElement(Alert, { tone: 'success', role: 'status', children: 'Backtest completed' }));
  assert.match(status, /role="status"/);
  assert.match(status, /aria-live="polite"/, 'a status update waits for a pause in speech');
  assert.match(status, /aria-atomic="true"/, 'the whole message is announced, not the diff');

  const alert = renderToStaticMarkup(
    React.createElement(Alert, { tone: 'danger', title: 'Backtest failed', role: 'alert', children: 'Rate limit exceeded.' }),
  );
  assert.match(alert, /role="alert"/);
  assert.match(alert, /aria-live="assertive"/, 'an error interrupts immediately');
  assert.match(alert, /aria-atomic="true"/);

  // No role → exactly the pre-existing markup: no live region is introduced
  // globally, so unrelated existing UI keeps behaving as before.
  const plain = renderToStaticMarkup(React.createElement(Alert, { tone: 'info', children: 'Heads up' }));
  assert.ok(!plain.includes('role='), 'no role attribute');
  assert.ok(!plain.includes('aria-live'), 'no aria-live attribute');
});

test('Spinner — names what is loading, and stays silent when unnamed', () => {
  const named = renderToStaticMarkup(React.createElement(Spinner, { label: 'Loading trades' }));
  assert.match(named, /role="status"/);
  assert.match(named, /aria-live="polite"/);
  assert.match(named, /<span class="sr-only">Loading trades<\/span>/, 'the label is screen-reader only');

  const unnamed = renderToStaticMarkup(React.createElement(Spinner, {}));
  assert.ok(!unnamed.includes('role='), 'opt-in only');
  assert.ok(unnamed.includes('animate-spin'), 'the visual spinner is unchanged');
});

test('LinkButton — a real anchor styled as a button, with no nested button', () => {
  const html = renderToStaticMarkup(
    React.createElement(LinkButton, { href: '/backtests/new', variant: 'secondary' }, 'New backtest'),
  );
  assert.match(html, /^<a /, `renders an anchor, got: ${html.slice(0, 80)}`);
  assert.match(html, /href="\/backtests\/new"/);
  assert.ok(!html.includes('<button'), 'no button nested inside the anchor');
  assert.ok(html.includes('New backtest</a>'), 'the label is the link text');
  // Focus styling must survive, or the control is invisible to keyboard users.
  assert.ok(html.includes('focus-visible:outline'), 'keyboard focus ring present');
});

test('LinkButton and Button share one styling contract', () => {
  for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
    const link = renderToStaticMarkup(React.createElement(LinkButton, { href: '/alerts', variant }, 'Go'));
    const button = renderToStaticMarkup(React.createElement(Button, { variant, type: 'button' }, 'Go'));
    const linkClass = /class="([^"]+)"/.exec(link)?.[1];
    const buttonClassAttr = /class="([^"]+)"/.exec(button)?.[1];
    assert.equal(linkClass, buttonClassAttr, `${variant} link and button look identical`);
    assert.equal(linkClass, buttonClass(variant));
  }
});
