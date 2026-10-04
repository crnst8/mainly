import assert from 'node:assert/strict';
import test from 'node:test';
import { headerValue, htmlToText, isMarkedSpam, looksLikeHtml, toPreview } from './parse.ts';

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

test('reads one folded header out of a block', () => {
  const raw = 'References: <a@x>\r\n <b@x>\r\nX-Spam-Flag: YES\r\n';
  assert.equal(headerValue(raw, 'references'), '<a@x> <b@x>');
  assert.equal(headerValue(raw, 'x-spam-flag'), 'YES');
  assert.equal(headerValue(raw, 'subject'), null);
});

test('recognises the server spam verdict and nothing else', () => {
  assert.equal(isMarkedSpam('***SPAM*** Cheap watches', null), true);
  assert.equal(isMarkedSpam('  *** SPAM *** lower', null), true);
  assert.equal(isMarkedSpam('Hello', 'X-Spam-Flag: YES\r\n'), true);
  assert.equal(isMarkedSpam('Hello', 'X-Spam-Flag: NO\r\n'), false);
  assert.equal(isMarkedSpam('Re: ***SPAM*** in my inbox', null), false);
  assert.equal(isMarkedSpam('Spam report for May', null), false);
});
