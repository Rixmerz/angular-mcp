import { describe, expect, it } from 'vitest';

import { MAX_MARKDOWN_BYTES, truncateMarkdown } from '../../src/format/truncate.js';

describe('truncateMarkdown', () => {
  it('leaves short text untouched and reports truncated: false', () => {
    const result = truncateMarkdown('hello', { shownCount: 1, totalCount: 1, nextOffset: null });
    expect(result).toEqual({ text: 'hello', truncated: false });
  });

  it('truncates text over the byte budget and declares it', () => {
    const line = 'x'.repeat(100) + '\n';
    const text = line.repeat(200); // ~20 KB, well over the 8 KB cap
    const result = truncateMarkdown(text, { shownCount: 200, totalCount: 200, nextOffset: null });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    expect(result.text).toMatch(/truncat/i);
  });

  it('explains how to request the rest when there is a next_offset', () => {
    const text = 'y'.repeat(MAX_MARKDOWN_BYTES * 2);
    const result = truncateMarkdown(text, { shownCount: 20, totalCount: 500, nextOffset: 20 });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('offset=20');
  });

  it('explains an alternative when there is no next_offset', () => {
    const text = 'z'.repeat(MAX_MARKDOWN_BYTES * 2);
    const result = truncateMarkdown(text, { shownCount: 500, totalCount: 500, nextOffset: null });

    expect(result.truncated).toBe(true);
    expect(result.text.toLowerCase()).toContain('json');
  });

  it('never splits a multi-byte UTF-8 character at the cut boundary', () => {
    const text = '日本語のテキスト。'.repeat(2000);
    const result = truncateMarkdown(text, { shownCount: 1, totalCount: 1, nextOffset: null });

    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('�');
    // Re-encoding round-trips cleanly: no partial character survived.
    expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text);
  });

  it('respects a custom maxBytes', () => {
    const text = 'a'.repeat(3000);
    const result = truncateMarkdown(text, { shownCount: 1, totalCount: 1, nextOffset: null }, 1024);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(1024);
  });
});
