import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendDictationToBuffer, formatLiveDictationText } from '../src/lib/dictation.js';

test('appendDictationToBuffer returns currentBuffer when transcript is empty or whitespace', () => {
  assert.equal(appendDictationToBuffer('', ''), '');
  assert.equal(appendDictationToBuffer('', '   \t\n '), '');
  assert.equal(appendDictationToBuffer('hello', ''), 'hello');
  assert.equal(appendDictationToBuffer('hello ', '   '), 'hello ');
});

test('appendDictationToBuffer appends trimmed transcript directly when buffer is empty', () => {
  assert.equal(appendDictationToBuffer('', '  hello world  '), 'hello world');
});

test('appendDictationToBuffer appends directly when buffer ends with whitespace', () => {
  assert.equal(appendDictationToBuffer('hello ', '  world  '), 'hello world');
  assert.equal(appendDictationToBuffer('hello\t', 'world'), 'hello\tworld');
  assert.equal(appendDictationToBuffer('hello\n', 'world'), 'hello\nworld');
});

test('appendDictationToBuffer inserts a single space when buffer does not end with whitespace', () => {
  assert.equal(appendDictationToBuffer('hello', '  world  '), 'hello world');
  assert.equal(appendDictationToBuffer('first sentence.', 'Second sentence.'), 'first sentence. Second sentence.');
});

test('formatLiveDictationText returns empty string when transcript is empty or whitespace', () => {
  assert.equal(formatLiveDictationText('', false), '');
  assert.equal(formatLiveDictationText('', true), '');
  assert.equal(formatLiveDictationText('   \n\t ', true), '');
});

test('formatLiveDictationText trims transcript when needsLeadingSpace is false', () => {
  assert.equal(formatLiveDictationText('  hello world  ', false), 'hello world');
  assert.equal(formatLiveDictationText(' , yes ', false), ', yes');
});

test('formatLiveDictationText prepends a space when needsLeadingSpace is true for regular words', () => {
  assert.equal(formatLiveDictationText('  next sentence  ', true), ' next sentence');
  assert.equal(formatLiveDictationText('(aside)', true), ' (aside)');
});

test('formatLiveDictationText omits leading space before closing or trailing punctuation', () => {
  for (const text of [', right', '. Next', '; also', ': details', '! Wow', '? Really', ')']) {
    assert.equal(formatLiveDictationText(`  ${text}  `, true), text);
  }
});
