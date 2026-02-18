const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Test the line buffer logic in isolation
describe('createLineBuffer (extracted for testing)', () => {
  it('buffers partial lines', () => {
    const lines = [];
    // Inline the buffer logic for testing
    let partial = '';
    const onChunk = (chunk) => {
      partial += chunk;
      const parts = partial.split('\n');
      partial = parts.pop();
      for (const p of parts) lines.push(p);
    };

    onChunk('hello wo');
    assert.deepEqual(lines, []);
    onChunk('rld\ngoodbye\n');
    assert.deepEqual(lines, ['hello world', 'goodbye']);
  });

  it('handles complete lines', () => {
    const lines = [];
    let partial = '';
    const onChunk = (chunk) => {
      partial += chunk;
      const parts = partial.split('\n');
      partial = parts.pop();
      for (const p of parts) lines.push(p);
    };

    onChunk('line1\nline2\nline3\n');
    assert.deepEqual(lines, ['line1', 'line2', 'line3']);
  });
});
