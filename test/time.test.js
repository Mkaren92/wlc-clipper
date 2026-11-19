import { describe, expect, it } from 'vitest';
import { formatClock, parseTime } from '../src/time.js';

describe('parseTime', () => {
  it.each([
    ['0', 0],
    ['90', 90],
    ['754.5', 754.5],
    ['12:34.5', 754.5],
    ['13:05', 785],
    ['0:07', 7],
    ['90:00', 5400],
    ['1:02:03', 3723],
    ['01:02:03.25', 3723.25],
    [' 12:34 ', 754],
  ])('reads %s as %d seconds', (text, seconds) => {
    expect(parseTime(text)).toBe(seconds);
  });

  it.each([
    '',
    'abc',
    '-5',
    '1:2:3:4',
    '12:',
    ':30',
    '1:75',
    '1:60:00',
    '1.5:30',
    '12:34,5',
    '1e3',
  ])('rejects %j', (text) => {
    expect(() => parseTime(text)).toThrow(/is not a time/);
  });
});

describe('formatClock', () => {
  it.each([
    [0, '0:00.00'],
    [7, '0:07.00'],
    [754.5, '12:34.50'],
    [3723.25, '1:02:03.25'],
    [59.999, '1:00.00'],
    [3599.996, '1:00:00.00'],
  ])('writes %d as %s', (seconds, text) => {
    expect(formatClock(seconds)).toBe(text);
  });
});
