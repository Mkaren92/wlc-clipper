import { describe, expect, it } from 'vitest';
import { buildAss, checkHook, cleanOverlayText } from '../src/captions/ass.js';
import { displayText, groupWords } from '../src/captions/group.js';
import { readPauses, snapToSpeech } from '../src/captions/pauses.js';
import { captionWidth } from '../src/captions/width.js';
import { formatAssTime } from '../src/time.js';
import { checkTranscript } from '../src/transcribe/index.js';

/** Build words that follow each other without pauses, 0.3 s each. */
function words(...texts) {
  return texts.map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.3 }));
}

describe('groupWords', () => {
  it('puts at most three words in a group', () => {
    const groups = groupWords(words('a', 'b', 'c', 'd', 'e', 'f', 'g'), 60);
    expect(groups.map((g) => g.text)).toEqual(['A B C', 'D E F', 'G']);
  });

  it('keeps a group within 18 characters', () => {
    const groups = groupWords(words('everything', 'happens', 'eventually'), 60);
    expect(groups.map((g) => g.text)).toEqual(['EVERYTHING HAPPENS', 'EVENTUALLY']);
    const tight = groupWords(words('everything', 'happened', 'ok'), 60);
    expect(tight.map((g) => g.text)).toEqual(['EVERYTHING', 'HAPPENED OK']);
  });

  it('starts a new group after a pause longer than 0.4 seconds', () => {
    const groups = groupWords(
      [
        { text: 'wait', start: 0, end: 0.3 },
        { text: 'what', start: 0.8, end: 1.1 },
      ],
      60,
    );
    expect(groups.map((g) => g.text)).toEqual(['WAIT', 'WHAT']);
  });

  it('starts a new group after sentence punctuation', () => {
    const groups = groupWords(words('No', 'way.', 'He', 'did!', 'Really?"', 'yes'), 60);
    expect(groups.map((g) => g.text)).toEqual(['NO WAY', 'HE DID', 'REALLY', 'YES']);
  });

  it('ends a group at the next group or 0.15 seconds after its last word, whichever is first', () => {
    const groups = groupWords(
      [
        { text: 'one', start: 0.32, end: 0.48 },
        { text: 'two.', start: 0.48, end: 0.66 },
        { text: 'three', start: 0.7, end: 0.95 },
        { text: 'four', start: 2, end: 2.4 },
      ],
      60,
    );
    expect(groups).toEqual([
      { text: 'ONE TWO', start: 0.32, end: 0.7 },
      { text: 'THREE', start: 0.7, end: 0.95 + 0.15 },
      { text: 'FOUR', start: 2, end: 2.55 },
    ]);
  });

  it('never runs past the end of the clip and drops words after it', () => {
    const groups = groupWords(
      [
        { text: 'last', start: 9.8, end: 10.3 },
        { text: 'gone', start: 11, end: 11.2 },
      ],
      10,
    );
    expect(groups).toEqual([{ text: 'LAST', start: 9.8, end: 10 }]);
  });

  it('skips words that are only punctuation', () => {
    expect(groupWords(words('well', '...', 'ok'), 60).map((g) => g.text)).toEqual(['WELL OK']);
  });

  it('returns nothing for no words', () => {
    expect(groupWords([], 60)).toEqual([]);
  });
});

describe('snapToSpeech', () => {
  const pauses = [{ start: 8.55, end: 9.05 }];
  const snap = (start, end) => {
    const [word] = snapToSpeech([{ text: 'by', start, end }], pauses);
    return [word.start, word.end];
  };

  it('starts a word after the pause it was stretched across', () => {
    // Measured on real speech: "by" was timed 8.46-9.30 but spoken from 9.05.
    expect(snap(8.46, 9.3)).toEqual([9.05, 9.3]);
    expect(snap(8.6, 9.3)).toEqual([9.05, 9.3]);
  });

  it('ends a word before the pause when most of it lies ahead of the pause', () => {
    expect(snap(8.0, 9.1)).toEqual([8.0, 8.55]);
  });

  it('leaves words that barely touch a pause, or lie inside one, alone', () => {
    expect(snap(8.0, 8.7)).toEqual([8.0, 8.7]);
    expect(snap(8.6, 8.9)).toEqual([8.6, 8.9]);
    expect(snap(9.1, 9.4)).toEqual([9.1, 9.4]);
  });

  it('keeps the other fields of a word', () => {
    expect(snapToSpeech([{ text: 'by', start: 1, end: 2, probability: 0.9 }], [])).toEqual([
      { text: 'by', start: 1, end: 2, probability: 0.9 },
    ]);
  });
});

describe('readPauses', () => {
  it('reads start and end pairs, and runs an open pause to the end', () => {
    const log = [
      '[silencedetect @ 0x1] silence_start: 8.53106',
      '[silencedetect @ 0x1] silence_end: 9.04756 | silence_duration: 0.5165',
      '[silencedetect @ 0x1] silence_start: 28.9',
    ].join('\n');
    expect(readPauses(log)).toEqual([
      { start: 8.53106, end: 9.04756 },
      { start: 28.9, end: Infinity },
    ]);
  });

  it('finds none in a log without pauses', () => {
    expect(readPauses('size=N/A time=00:00:30.00')).toEqual([]);
  });
});

describe('displayText', () => {
  it.each([
    ['Hello,', 'HELLO'],
    ["don't", "DON'T"],
    ['co-op', 'CO-OP'],
    ['"Really?"', 'REALLY'],
    ['{\\b1}bold', 'B1BOLD'],
    ['$5', '$5'],
    ['—', ''],
  ])('shows %j as %j', (text, shown) => {
    expect(displayText(text)).toBe(shown);
  });
});

describe('formatAssTime', () => {
  it.each([
    [0, '0:00:00.00'],
    [0.32, '0:00:00.32'],
    [2.5, '0:00:02.50'],
    [59.999, '0:01:00.00'],
    [3723.25, '1:02:03.25'],
  ])('writes %d as %s', (seconds, text) => {
    expect(formatAssTime(seconds)).toBe(text);
  });
});

describe('buildAss', () => {
  const groups = [
    { text: 'HE DID NOT', start: 0.32, end: 0.95 },
    { text: 'EXPECT THAT', start: 0.95, end: 1.8 },
  ];

  it('writes captions and the hook as events on a 1080x1920 canvas', () => {
    const ass = buildAss({ groups, hook: 'He did NOT expect that', layout: 'center', clipSeconds: 30 });
    expect(ass).toContain('PlayResX: 1080\nPlayResY: 1920');
    expect(ass).toContain('Style: Caption,Liberation Sans,88,');
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:00:02.50,Hook,,0,0,0,,{\\q0}He did NOT expect that');
    expect(ass).toContain('Dialogue: 0,0:00:00.32,0:00:00.95,Caption,,0,0,0,,HE DID NOT');
    expect(ass).toContain('Dialogue: 0,0:00:00.95,0:00:01.80,Caption,,0,0,0,,EXPECT THAT');
  });

  it('gives every style line as many fields as the format line', () => {
    const lines = buildAss({ groups, layout: 'center', clipSeconds: 30 }).split('\n');
    const fields = lines.find((line) => line.startsWith('Format: Name')).split(',').length;
    const styles = lines.filter((line) => line.startsWith('Style:'));
    expect(styles).toHaveLength(2);
    for (const style of styles) expect(style.split(',')).toHaveLength(fields);
  });

  it('moves the hook under the webcam panel in the facecam layout', () => {
    const ass = buildAss({ hook: 'Look at this', layout: 'facecam', clipSeconds: 30 });
    expect(ass).toContain(',Hook,,0,0,670,,{\\q0}Look at this');
  });

  it('ends the hook with the clip when the clip is shorter', () => {
    const ass = buildAss({ hook: 'Quick', layout: 'center', clipSeconds: 1.2 });
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:00:01.20,Hook');
  });

  it('shrinks a line of wide letters so it stays inside the frame', () => {
    const wide = [{ text: 'WWWWWW MMMMM WWWWW', start: 0, end: 1 }];
    const ass = buildAss({ groups: wide, layout: 'center', clipSeconds: 30 });
    expect(ass).toContain(',,{\\fscx81\\fscy81}WWWWWW MMMMM WWWWW');
  });

  it('has no events without captions or a hook', () => {
    expect(buildAss({ layout: 'center', clipSeconds: 30 })).not.toContain('Dialogue:');
  });
});

describe('captionWidth', () => {
  // Widths measured from frames rendered by ffmpeg with the bundled font.
  it.each([
    ['EVERYTHING HAPPENS', 908],
    ['HHHHHHHHHH', 560],
    ['WWWWWWWWWW', 744],
    ['0123456789', 432],
    ["DON'T CO-OP $5 100%", 849],
    ['QGCDB JKPVXYZ', 669],
  ])('estimates %j close to the rendered %d px', (text, measured) => {
    expect(Math.abs(captionWidth(text) - measured)).toBeLessThanOrEqual(10);
  });

  it('counts an unknown character as the widest letter', () => {
    expect(captionWidth('Ж')).toBe(captionWidth('W'));
  });
});

describe('hook text', () => {
  it('removes subtitle control characters and line breaks', () => {
    expect(cleanOverlayText('He {\\b1}did\n NOT  expect\\N that')).toBe('He b1did NOT expectN that');
  });

  it('accepts 60 characters and rejects 61', () => {
    expect(checkHook('x'.repeat(60))).toHaveLength(60);
    expect(() => checkHook('x'.repeat(61))).toThrow(/limit is 60/);
  });

  it('rejects an empty hook', () => {
    expect(() => checkHook('  {} ')).toThrow(/empty/);
  });
});

describe('checkTranscript', () => {
  it('accepts a well-formed transcript', () => {
    const transcript = { language: 'en', words: [{ text: 'He', start: 0.32, end: 0.48 }] };
    expect(checkTranscript(transcript)).toBe(transcript);
  });

  it('names the word that is wrong', () => {
    const words = [
      { text: 'He', start: 0.32, end: 0.48 },
      { text: 'did', start: '0.5', end: 0.6 },
    ];
    expect(() => checkTranscript({ words })).toThrow(/word 2 must look like/);
  });

  it('rejects a file without a words list', () => {
    expect(() => checkTranscript({ language: 'en' })).toThrow(/"words" list/);
  });
});
