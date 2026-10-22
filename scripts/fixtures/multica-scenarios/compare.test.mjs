import assert from 'node:assert/strict';
import test from 'node:test';

import { compareStrings } from './compare.mjs';

test('identical strings are the same', () => {
  assert.equal(compareStrings('ALPHA', 'ALPHA'), 'SAME');
});

test('different strings differ', () => {
  assert.equal(compareStrings('ALPHA', 'BETA'), 'DIFFERENT');
});
