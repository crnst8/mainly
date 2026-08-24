import assert from 'node:assert/strict';
import test from 'node:test';
import { htmlToText, looksLikeHtml, toPreview } from './parse.ts';

test('turns ordinary and entity-encoded HTML into preview text', () => {
  assert.equal(toPreview('<div>Hello <strong>world</strong></div>', true), 'Hello world');
  assert.equal(toPreview('&lt;div&gt;Hello &amp;amp; welcome&lt;/div&gt;', true), 'Hello & welcome');
});

test('sniffs HTML that was mislabeled as plain text', () => {
  const raw = '<!doctype html><html><body><p>Your receipt is ready.</p></body></html>';
  assert.equal(looksLikeHtml(raw), true);
  assert.equal(toPreview(raw, false), 'Your receipt is ready.');
});

test('drops truncated non-content blocks instead of exposing CSS', () => {
  assert.equal(htmlToText('<style>.button { color: red; }'), '');
  assert.equal(toPreview('&lt;html xmlns="http://www.w3.org/1999/xhtml"', false), '');
});

test('leaves angle brackets in ordinary plain text alone', () => {
  const text = 'The total is < 10 and the maximum is > 4.';
  assert.equal(looksLikeHtml(text), false);
  assert.equal(toPreview(text, false), text);
});

test('ignores invalid numeric entities rather than throwing', () => {
  assert.equal(htmlToText('<p>&#999999999999; stays readable</p>'), '&#999999999999; stays readable');
});
