import { describe, it, expect } from 'vitest';
import {
  formatDate,
  formatMessage,
  formatCall,
  toFTS5Query,
  parseDateToTs,
  mergeContextGroups,
} from '../lib/signal-db.js';

describe('formatDate', () => {
  it('returns "-" for null/undefined/0', () => {
    expect(formatDate(null)).toBe('-');
    expect(formatDate(undefined)).toBe('-');
    expect(formatDate(0)).toBe('-');
  });

  it('formats a known timestamp', () => {
    // 2025-06-15T12:30:00Z
    const ts = 1750000200000;
    const result = formatDate(ts);
    expect(result).toContain('2025');
    expect(result).toContain('15');
  });
});

describe('formatMessage', () => {
  it('formats a basic message', () => {
    const msg = { body: 'Hello world', type: 'incoming', conversationName: 'Alice' };
    const result = formatMessage(msg);
    expect(result.body).toBe('Hello world');
    expect(result.conv).toBe('Alice');
    expect(result.dir).toBe('▶');
  });

  it('shows outgoing direction', () => {
    const msg = { body: 'Hi', type: 'outgoing' };
    const result = formatMessage(msg);
    expect(result.dir).toBe('◀');
  });

  it('truncates long body with ellipsis', () => {
    const msg = { body: 'A'.repeat(100), type: 'incoming' };
    const result = formatMessage(msg);
    expect(result.body).toBe('A'.repeat(80) + '...');
  });

  it('respects custom bodyMaxLen', () => {
    const msg = { body: 'A'.repeat(50), type: 'incoming' };
    const result = formatMessage(msg, { bodyMaxLen: 20 });
    expect(result.body).toBe('A'.repeat(20) + '...');
  });

  it('shows "(no text)" for missing body', () => {
    const msg = { type: 'incoming' };
    const result = formatMessage(msg);
    expect(result.body).toBe('(no text)');
  });

  it('replaces newlines with spaces', () => {
    const msg = { body: 'line1\nline2\nline3', type: 'incoming' };
    const result = formatMessage(msg);
    expect(result.body).toBe('line1 line2 line3');
  });

  it('falls back conv to phone, id, or "?"', () => {
    expect(formatMessage({ body: 'x', conversationPhone: '+420' }).conv).toBe('+420');
    expect(formatMessage({ body: 'x', conversationId: 'abc' }).conv).toBe('abc');
    expect(formatMessage({ body: 'x' }).conv).toBe('?');
  });
});

describe('formatCall', () => {
  it('formats incoming call', () => {
    const result = formatCall({ callDirection: 'incoming', callStatus: 'Accepted' });
    expect(result).toContain('📞↓');
    expect(result).toContain('Accepted');
  });

  it('formats outgoing call', () => {
    const result = formatCall({ callDirection: 'outgoing', callStatus: 'Declined' });
    expect(result).toContain('📞↑');
    expect(result).toContain('Declined');
  });

  it('includes mode unless Group', () => {
    expect(formatCall({ callDirection: 'incoming', callStatus: 'ok', callMode: 'Direct' })).toContain('Direct');
    expect(formatCall({ callDirection: 'incoming', callStatus: 'ok', callMode: 'Group' })).not.toContain('Group');
  });

  it('handles missing fields', () => {
    const result = formatCall({});
    expect(result).toContain('📞↑');
    expect(result).toContain('?');
  });
});

describe('toFTS5Query', () => {
  it('returns empty for null/undefined/empty', () => {
    expect(toFTS5Query(null)).toBe('');
    expect(toFTS5Query(undefined)).toBe('');
    expect(toFTS5Query('')).toBe('');
    expect(toFTS5Query('  ')).toBe('');
  });

  it('single word gets prefix *', () => {
    expect(toFTS5Query('hello')).toBe('hello*');
  });

  it('space-separated words become OR', () => {
    expect(toFTS5Query('ahoj deadline')).toBe('(ahoj* OR deadline*)');
  });

  it('comma-separated words become AND', () => {
    expect(toFTS5Query('ahoj, deadline')).toBe('ahoj* AND deadline*');
  });

  it('mixed space and comma', () => {
    expect(toFTS5Query('ahoj svete, deadline')).toBe('(ahoj* OR svete*) AND deadline*');
  });
});

describe('parseDateToTs', () => {
  it('returns null for null/undefined/empty', () => {
    expect(parseDateToTs(null)).toBeNull();
    expect(parseDateToTs(undefined)).toBeNull();
    expect(parseDateToTs('')).toBeNull();
  });

  it('returns number as-is', () => {
    expect(parseDateToTs(12345)).toBe(12345);
  });

  it('parses ISO date to start of day', () => {
    const ts = parseDateToTs('2025-01-15');
    const d = new Date(ts);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('parses ISO date to end of day', () => {
    const ts = parseDateToTs('2025-01-15', true);
    const d = new Date(ts);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
  });

  it('parses relative offset in minutes', () => {
    const before = Date.now() - 10 * 60 * 1000;
    const ts = parseDateToTs('10m');
    const after = Date.now() - 10 * 60 * 1000;
    expect(ts).toBeGreaterThanOrEqual(after);
    expect(ts).toBeLessThanOrEqual(before + 50);
  });

  it('parses relative offset in hours', () => {
    const before = Date.now() - 5 * 60 * 60 * 1000;
    const ts = parseDateToTs('5h');
    expect(ts).toBeGreaterThanOrEqual(before - 50);
    expect(ts).toBeLessThanOrEqual(before + 50);
  });

  it('parses relative offset in days', () => {
    const before = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const ts = parseDateToTs('3d');
    expect(ts).toBeGreaterThanOrEqual(before - 50);
    expect(ts).toBeLessThanOrEqual(before + 50);
  });

  it('ignores endOfDay for relative offsets', () => {
    const ts1 = parseDateToTs('5h', false);
    const ts2 = parseDateToTs('5h', true);
    expect(Math.abs(ts1 - ts2)).toBeLessThan(100);
  });

  it('throws on invalid string', () => {
    expect(() => parseDateToTs('blbost')).toThrow('Invalid date format');
    expect(() => parseDateToTs('not-a-date')).toThrow('Invalid date format');
  });
});

describe('mergeContextGroups', () => {
  const msg = (id, sentAt, convId = 'c1', convName = 'Alice') => ({
    id, sent_at: sentAt, conversationId: convId, conversationName: convName, body: `msg-${id}`, type: 'incoming',
  });

  it('single match with before/after context', () => {
    const matches = [msg('m1', 100)];
    const contextMap = new Map([
      ['m1', { before: [msg('b1', 90), msg('b2', 80)], after: [msg('a1', 110)] }],
    ]);
    const groups = mergeContextGroups(matches, contextMap);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(4);
    expect(groups[0].messages.map((m) => m.id)).toEqual(['b2', 'b1', 'm1', 'a1']);
    expect(groups[0].messages[2].isMatch).toBe(true);
    expect(groups[0].messages[0].isMatch).toBe(false);
  });

  it('two non-overlapping matches produce two groups', () => {
    const matches = [msg('m1', 100), msg('m2', 300)];
    const contextMap = new Map([
      ['m1', { before: [msg('b1', 90)], after: [msg('a1', 110)] }],
      ['m2', { before: [msg('b2', 290)], after: [msg('a2', 310)] }],
    ]);
    const groups = mergeContextGroups(matches, contextMap);
    expect(groups).toHaveLength(2);
    expect(groups[0].messages.map((m) => m.id)).toEqual(['b1', 'm1', 'a1']);
    expect(groups[1].messages.map((m) => m.id)).toEqual(['b2', 'm2', 'a2']);
  });

  it('overlapping windows merge into one group', () => {
    const matches = [msg('m1', 100), msg('m2', 120)];
    const contextMap = new Map([
      ['m1', { before: [msg('b1', 90)], after: [msg('shared', 110), msg('a1', 120)] }],
      ['m2', { before: [msg('shared', 110)], after: [msg('a2', 130)] }],
    ]);
    const groups = mergeContextGroups(matches, contextMap);
    expect(groups).toHaveLength(1);
    // shared appears once (dedup), m2 at 120 = a1 at 120 should also dedup
    const ids = groups[0].messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(groups[0].messages.find((m) => m.id === 'm1').isMatch).toBe(true);
    expect(groups[0].messages.find((m) => m.id === 'm2').isMatch).toBe(true);
    expect(groups[0].messages.find((m) => m.id === 'shared').isMatch).toBe(false);
  });

  it('matches in different conversations produce separate groups', () => {
    const matches = [msg('m1', 100, 'c1', 'Alice'), msg('m2', 100, 'c2', 'Bob')];
    const contextMap = new Map([
      ['m1', { before: [], after: [] }],
      ['m2', { before: [], after: [] }],
    ]);
    const groups = mergeContextGroups(matches, contextMap);
    expect(groups).toHaveLength(2);
    expect(groups[0].conversationName).toBe('Alice');
    expect(groups[1].conversationName).toBe('Bob');
  });

  it('match with no context returns single-message group', () => {
    const matches = [msg('m1', 100)];
    const contextMap = new Map();
    const groups = mergeContextGroups(matches, contextMap);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(1);
    expect(groups[0].messages[0].isMatch).toBe(true);
  });

  it('preserves isMatch when context message is also a match', () => {
    const matches = [msg('m1', 100), msg('m2', 110)];
    const contextMap = new Map([
      ['m1', { before: [], after: [msg('m2', 110)] }],
      ['m2', { before: [msg('m1', 100)], after: [] }],
    ]);
    const groups = mergeContextGroups(matches, contextMap);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
    expect(groups[0].messages.every((m) => m.isMatch)).toBe(true);
  });
});
