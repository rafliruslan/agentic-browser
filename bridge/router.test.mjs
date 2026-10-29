import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickModel, EFFORT } from './router.mjs';

test('every route runs at high effort', () => {
  assert.equal(EFFORT, 'high');
  for (const text of ['is 2+2 4?', 'screenshot the page', 'investigate this', 'deep: why', 'fast: hi']) {
    assert.equal(pickModel(text).effort, 'high', text);
  }
});

test('the model still follows the message', () => {
  assert.equal(pickModel('what is next').model, 'sonnet');
  assert.equal(pickModel('fast: investigate this').model, 'sonnet');
  assert.equal(pickModel('deep: hi').model, 'opus');
  assert.equal(pickModel('take a screenshot').model, 'opus');
});
