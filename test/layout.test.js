import { describe, expect, it } from 'vitest';
import { buildFilter } from '../src/layout.js';

const landscape = { width: 1920, height: 1080 };

describe('center layout', () => {
  it('crops a centred 9:16 column from a 16:9 source', () => {
    const { graph, cropX } = buildFilter({ layout: 'center', source: landscape });
    expect(graph).toBe('[0:v]fps=30,crop=606:1080:657:0,scale=1080:1920,setsar=1[v]');
    expect(cropX).toBe(657);
  });

  it('uses --crop-x as the left edge of the crop', () => {
    const { graph, cropX } = buildFilter({ layout: 'center', source: landscape, cropX: 100 });
    expect(graph).toContain('crop=606:1080:100:0');
    expect(cropX).toBe(100);
  });

  it('keeps the crop inside the frame', () => {
    expect(buildFilter({ layout: 'center', source: landscape, cropX: 5000 }).cropX).toBe(1314);
  });

  it('only scales a source that is already 9:16', () => {
    const { graph, cropX } = buildFilter({ layout: 'center', source: { width: 720, height: 1280 } });
    expect(graph).toBe('[0:v]fps=30,scale=1080:1920,setsar=1[v]');
    expect(cropX).toBeNull();
  });

  it('trims top and bottom of a source taller than 9:16', () => {
    const { graph } = buildFilter({ layout: 'center', source: { width: 1080, height: 2400 } });
    expect(graph).toBe('[0:v]fps=30,crop=1080:1920:0:240,scale=1080:1920,setsar=1[v]');
  });

  it('refuses --crop-x when there is nothing to crop sideways', () => {
    expect(() => buildFilter({ layout: 'center', source: { width: 720, height: 1280 }, cropX: 10 })).toThrow(
      /wider than 9:16/,
    );
  });
});

describe('blur layout', () => {
  it('puts the whole frame over a blurred copy', () => {
    const { graph, cropX } = buildFilter({ layout: 'blur', source: landscape });
    expect(graph).toContain('boxblur');
    expect(graph).toMatch(/^\[0:v\]fps=30,split=2/);
    expect(graph).toMatch(/\[v\]$/);
    expect(cropX).toBeNull();
  });

  it('refuses --crop-x', () => {
    expect(() => buildFilter({ layout: 'blur', source: landscape, cropX: 10 })).toThrow(/center layout/);
  });
});

describe('--trim', () => {
  it('cuts the edges off before the center crop, keeping --crop-x in source pixels', () => {
    const { graph, cropX } = buildFilter({ layout: 'center', source: landscape, trim: 10 });
    // 1900x1060 is left; the 9:16 window is 596 wide and still centred.
    expect(graph).toBe('[0:v]fps=30,crop=596:1060:662:10,scale=1080:1920,setsar=1[v]');
    expect(cropX).toBe(662);
    expect(buildFilter({ layout: 'center', source: landscape, trim: 10, cropX: 0 }).cropX).toBe(10);
    expect(buildFilter({ layout: 'center', source: landscape, trim: 10, cropX: 5000 }).cropX).toBe(1314);
  });

  it('cuts the edges off before the blur layout', () => {
    const { graph } = buildFilter({ layout: 'blur', source: landscape, trim: 10 });
    expect(graph).toMatch(/^\[0:v\]fps=30,crop=1900:1060:10:10,split=2/);
  });

  it('applies to a source that is already vertical', () => {
    const { graph } = buildFilter({ layout: 'center', source: { width: 1080, height: 1920 }, trim: 8 });
    expect(graph).toBe('[0:v]fps=30,crop=1064:1904:8:8,scale=1080:1920,setsar=1[v]');
  });

  it('is limited to a thin border', () => {
    expect(() => buildFilter({ layout: 'blur', source: landscape, trim: 55 })).toThrow(/at most 54 pixels/);
  });
});

describe('facecam layout', () => {
  const cam = { x: 1400, y: 40, width: 480, height: 270 };

  it('stacks the webcam rectangle over the middle of the gameplay', () => {
    const { graph, cropX } = buildFilter({ layout: 'facecam', source: landscape, cam });
    expect(graph).toBe(
      [
        '[0:v]fps=30,split=2[a][b]',
        '[a]crop=480:270:1400:40,scale=1080:640:force_original_aspect_ratio=increase,crop=1080:640[cam]',
        '[b]crop=910:1080:505:0,scale=1080:1280[game]',
        '[cam][game]vstack=inputs=2,setsar=1[v]',
      ].join(';'),
    );
    expect(cropX).toBeNull();
  });

  it('needs --cam', () => {
    expect(() => buildFilter({ layout: 'facecam', source: landscape })).toThrow(/needs --cam/);
  });

  it('rejects a webcam rectangle that leaves the frame', () => {
    const outside = { x: 1600, y: 40, width: 480, height: 270 };
    expect(() => buildFilter({ layout: 'facecam', source: landscape, cam: outside })).toThrow(/does not fit/);
  });

  it('is the only layout that takes --cam', () => {
    expect(() => buildFilter({ layout: 'center', source: landscape, cam })).toThrow(/facecam layout/);
  });
});

describe('subtitles', () => {
  it.each(['center', 'blur', 'facecam'])('are burned in last in the %s layout', (layout) => {
    const cam = layout === 'facecam' ? { x: 0, y: 0, width: 480, height: 270 } : undefined;
    const { graph } = buildFilter({ layout, source: landscape, cam, subtitles: true });
    expect(graph).toMatch(/,setsar=1,subtitles=captions\.ass:fontsdir=fonts\[v\]$/);
  });
});

describe('end card', () => {
  const endCard = { at: 27.5, seconds: 3 };

  it('holds the last frame, covers it with the card and pads the sound', () => {
    const { graph, audioLabel } = buildFilter({
      layout: 'center', source: { ...landscape, audioStreams: 1 }, subtitles: true, endCard,
    });
    expect(graph).toBe(
      [
        '[0:v]fps=30,crop=606:1080:657:0,scale=1080:1920,setsar=1,tpad=stop_mode=clone:stop_duration=3[base]',
        "[base][1:v]overlay=0:0:enable='gte(t,27.5)',subtitles=captions.ass:fontsdir=fonts[v]",
        '[0:a:0]apad=pad_dur=3[a]',
      ].join(';'),
    );
    expect(audioLabel).toBe('[a]');
  });

  it('centres a picture on the plain card before covering the footage', () => {
    const { graph } = buildFilter({
      layout: 'center', source: { ...landscape, audioStreams: 0 }, endCard: { ...endCard, image: true },
    });
    expect(graph).toBe(
      [
        '[0:v]fps=30,crop=606:1080:657:0,scale=1080:1920,setsar=1,tpad=stop_mode=clone:stop_duration=3[base]',
        '[2:v]scale=1080:1920:force_original_aspect_ratio=decrease[picture]',
        '[1:v][picture]overlay=(W-w)/2:(H-h)/2[card]',
        "[base][card]overlay=0:0:enable='gte(t,27.5)'[v]",
      ].join(';'),
    );
  });

  it('leaves the sound alone when the source has none', () => {
    const { graph, audioLabel } = buildFilter({ layout: 'blur', source: { ...landscape, audioStreams: 0 }, endCard });
    expect(graph).not.toContain('apad');
    expect(audioLabel).toBeNull();
  });
});

it('rejects an unknown layout', () => {
  expect(() => buildFilter({ layout: 'sideways', source: landscape })).toThrow(/Unknown layout/);
});
