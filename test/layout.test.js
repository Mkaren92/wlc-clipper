import { describe, expect, it } from 'vitest';
import { buildFilter, CAM_HEIGHT, checkBlurs, CAM_MAX_HEIGHT, CAM_MIN_HEIGHT, camPanelHeight, describeLayouts, facecamGameWindow, fitGameToPanel, gameFit, overlayBox, overlayInput, overlayKind, overlayWarnings } from '../src/layout.js';

const landscape = { width: 1920, height: 1080 };

describe('muffling the sound', () => {
  const source = { width: 1920, height: 1080, audioStreams: 1 };
  const windows = [{ start: 0.42, end: 0.92 }, { start: 3, end: 3.5 }];

  it('leaves the graph and the sound exactly as they were when there is nothing to muffle', () => {
    for (const endCard of [undefined, { at: 3, seconds: 1 }]) {
      const before = buildFilter({ layout: 'center', source, endCard });
      expect(buildFilter({ layout: 'center', source, endCard, muffle: [] })).toEqual(before);
    }
    expect(buildFilter({ layout: 'center', source, muffle: [] }).audioLabel).toBeNull(); // the source's own sound
  });

  it('muffles only inside the windows, before the silence under an end card', () => {
    const when = "enable='between(t,0.42,0.92)+between(t,3,3.5)'";
    const chain = `lowpass=f=300:${when},lowpass=f=300:${when},lowpass=f=300:${when},volume=1.5:${when}`;
    const plain = buildFilter({ layout: 'center', source });
    const muffled = buildFilter({ layout: 'center', source, muffle: windows });
    expect(muffled.graph).toBe(`${plain.graph};[0:a:0]${chain}[a]`); // the picture is untouched
    expect(muffled.audioLabel).toBe('[a]');
    expect(buildFilter({ layout: 'center', source, muffle: windows, endCard: { at: 4, seconds: 1 } }).graph).toContain(`;[0:a:0]${chain},apad=pad_dur=1[a]`);
    // A video with no sound has nothing to muffle.
    expect(buildFilter({ layout: 'center', source: { ...source, audioStreams: 0 }, muffle: windows })).toEqual(buildFilter({ layout: 'center', source: { ...source, audioStreams: 0 } }));
  });
});

describe('blur boxes', () => {
  const box = { x: 600, y: 300, width: 120, height: 80, start: 1, end: 2.5, style: 'blur' };

  it('leaves the graph exactly as before without any', () => {
    for (const layout of ['center', 'blur']) {
      expect(buildFilter({ layout, source: landscape, blurs: [] }).graph).toBe(buildFilter({ layout, source: landscape }).graph);
    }
  });

  it('covers the box on the source frames, only between its start and end, before the layout', () => {
    const { graph } = buildFilter({ layout: 'center', source: landscape, blurs: [box, { ...box, x: 100, style: 'black' }] });
    expect(graph.startsWith('[0:v]fps=30,split=2[bv0][bc0];[bc0]crop=120:80:600:300,scale=6:4,scale=120:80:flags=bicubic,boxblur=39:3:19:3[bz0];')).toBe(true);
    expect(graph).toContain("[bv0][bz0]overlay=600:300:enable='between(t,1,2.5)',drawbox=x=100:y=300:w=120:h=80:color=black:t=fill:enable='between(t,1,2.5)'[covered];[covered]null,crop=606:1080:657:0,");
    expect(graph.endsWith('setsar=1[v]')).toBe(true);
  });

  it('works under the facecam layout too', () => {
    const { graph } = buildFilter({ layout: 'facecam', source: landscape, cam: { x: 1400, y: 40, width: 480, height: 270 }, camHeight: 606, blurs: [box] });
    expect(graph).toContain('[covered];[covered]null,split=2[a][b]');
  });

  it('checks and tidies the boxes', () => {
    expect(checkBlurs([{ x: 601, y: 301, width: 121, height: 81, start: 1.234, end: 9 }], landscape, 5)).toEqual([
      { x: 600, y: 300, width: 120, height: 80, start: 1.23, end: 5, style: 'blur' },
    ]);
    expect(() => checkBlurs([{ ...box, x: 1850 }], landscape, 5)).toThrow(/does not fit/);
    expect(() => checkBlurs([{ ...box, width: 10 }], landscape, 5)).toThrow(/at least 16/);
    expect(() => checkBlurs([{ ...box, end: 1 }], landscape, 5)).toThrow(/end after it starts/);
    expect(() => checkBlurs([{ ...box, start: 6, end: 7 }], landscape, 5)).toThrow(/starts after the clip ends/);
    expect(() => checkBlurs([{ ...box, style: 'pixel' }], landscape, 5)).toThrow(/style must be one of/);
    expect(() => checkBlurs(Array(21).fill(box), landscape, 5)).toThrow(/at most 20/);
  });
});

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

describe('center layout with a wider crop', () => {
  it('shows a wider crop whole, over a blurred copy of itself', () => {
    const { graph, cropX, cropWidth } = buildFilter({ layout: 'center', source: landscape, cropWidth: 1000 });
    expect(graph).toBe([
      '[0:v]fps=30,crop=1000:1080:460:0,split=2[a][b]',
      '[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=5:5,scale=1080:1920:flags=bicubic[bg]',
      '[b]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]',
      '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]',
    ].join(';'));
    expect([cropX, cropWidth]).toEqual([460, 1000]);
  });

  it('moves the wider crop with --crop-x and keeps it inside the frame', () => {
    expect(buildFilter({ layout: 'center', source: landscape, cropWidth: 1000, cropX: 100 }).graph).toContain('crop=1000:1080:100:0');
    expect(buildFilter({ layout: 'center', source: landscape, cropWidth: 1000, cropX: 5000 }).cropX).toBe(920);
    // After a trim, the frame it has to stay inside is smaller.
    expect(buildFilter({ layout: 'center', source: landscape, cropWidth: 1000, cropX: 0, trim: 10 }).graph).toContain('crop=1000:1060:10:10');
  });

  it('is the plain column at the smallest width, with the graph unchanged', () => {
    const plain = buildFilter({ layout: 'center', source: landscape });
    for (const cropWidth of [606, 607, 100, 0]) {
      expect(buildFilter({ layout: 'center', source: landscape, cropWidth })).toEqual(plain);
    }
    expect(plain.cropWidth).toBeNull();
  });

  it('takes at most the whole width, and an even number of pixels', () => {
    const whole = buildFilter({ layout: 'center', source: landscape, cropWidth: 5000 });
    expect(whole.graph).toContain('crop=1920:1080:0:0');
    expect([whole.cropX, whole.cropWidth]).toEqual([0, 1920]);
    expect(buildFilter({ layout: 'center', source: landscape, cropWidth: 1001 }).cropWidth).toBe(1000);
  });

  it('refuses a width on the other layouts, and on a source that is not wider than 9:16', () => {
    expect(() => buildFilter({ layout: 'blur', source: landscape, cropWidth: 1000 })).toThrow(/--crop-width only applies to the center layout/);
    expect(() => buildFilter({ layout: 'facecam', source: landscape, cropWidth: 1000, cam: { x: 0, y: 0, width: 400, height: 237 } })).toThrow(/center layout/);
    expect(() => buildFilter({ layout: 'center', source: { width: 720, height: 1280 }, cropWidth: 700 })).toThrow(/--crop-width needs a source wider than 9:16/);
  });

  it('describes the same window for a screen to draw, with the range the width can take', () => {
    expect(describeLayouts(landscape).center).toEqual({ x: 657, y: 0, width: 606, height: 1080, minX: 0, maxX: 1314 });
    expect(describeLayouts(landscape).centerWidths).toEqual({ min: 606, max: 1920 });
    expect(describeLayouts(landscape, 0, 1000).center).toEqual({ x: 460, y: 0, width: 1000, height: 1080, minX: 0, maxX: 920 });
    expect(describeLayouts(landscape, 10, 1000)).toMatchObject({
      center: { x: 460, y: 10, width: 1000, height: 1060, minX: 10, maxX: 910 },
      centerWidths: { min: 596, max: 1900 },
    });
    expect(describeLayouts({ width: 720, height: 1280 }, 0, 700)).toMatchObject({ center: { width: 720, minX: null }, centerWidths: null });
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

  // Asked for on 2026-11-21: "not all cams are 16:9". The top panel takes the webcam box's shape.
  it('makes the webcam panel as tall as the box\'s shape, within limits', () => {
    expect(camPanelHeight({ width: 480, height: 270 })).toBe(606); // 16:9 (607.5, made even downwards)
    expect(camPanelHeight({ width: 400, height: 300 })).toBe(810); // 4:3
    expect(camPanelHeight({ width: 300, height: 300 })).toBe(1080); // square
    expect(camPanelHeight({ width: 900, height: 200 })).toBe(CAM_MIN_HEIGHT); // very wide: its sides are cut
    expect(camPanelHeight({ width: 200, height: 400 })).toBe(CAM_MAX_HEIGHT); // tall: its top and bottom are cut
    expect(camPanelHeight({ width: 1080, height: 640 })).toBe(640); // the old fixed shape
    expect(camPanelHeight(null)).toBe(CAM_HEIGHT);
    expect(camPanelHeight({ width: 333, height: 250 }) % 2).toBe(0);
  });

  it('stacks a 4:3 webcam over a shorter gameplay panel, with nothing of the webcam cut off', () => {
    const square = { x: 1400, y: 40, width: 400, height: 300 };
    const { graph } = buildFilter({ layout: 'facecam', source: landscape, cam: square, camHeight: camPanelHeight(square) });
    const game = facecamGameWindow(describeLayouts(landscape).area, 810);
    expect(graph).toBe(
      [
        '[0:v]fps=30,split=2[a][b]',
        '[a]crop=400:300:1400:40,scale=1080:810:force_original_aspect_ratio=increase,crop=1080:810[cam]',
        `[b]crop=${game.width}:${game.height}:${game.x}:${game.y},scale=1080:1110[game]`,
        '[cam][game]vstack=inputs=2,setsar=1[v]',
      ].join(';'),
    );
    // The gameplay window keeps the lower panel's shape.
    expect(Math.abs(game.width / game.height - 1080 / 1110)).toBeLessThan(0.01);
  });

  // Asked for the same day: the content box is resized apart from the webcam box.
  it('shows the owner\'s content box in the bottom panel, whatever the webcam box is', () => {
    const game = { x: 200, y: 300, width: 1200, height: 700 };
    const one = buildFilter({ layout: 'facecam', source: landscape, cam, camHeight: 606, game }).graph;
    const other = buildFilter({ layout: 'facecam', source: landscape, cam: { x: 1400, y: 40, width: 400, height: 300 }, camHeight: 810, game }).graph;
    // The same content box in both, cropped as drawn; only the panel's height follows the webcam.
    for (const graph of [one, other]) expect(graph).toContain('[b]crop=1200:700:200:300,split=2[gb][gf]');
    // Not the panel's shape: shown whole over a blurred copy of itself, never cropped.
    expect(one).toContain('[gb]scale=270:328:force_original_aspect_ratio=increase,crop=270:328,boxblur=5:5,scale=1080:1314:flags=bicubic[gbg]');
    expect(one).toContain('[gf]scale=1080:1314:force_original_aspect_ratio=decrease:force_divisible_by=2[gfg]');
    expect(one).toContain('[gbg][gfg]overlay=(W-w)/2:(H-h)/2[game]');
    expect(gameFit(game, 606)).toEqual({ fills: false, blurred: 'top and bottom' });
  });

  it('fills the bottom panel with no blur when the content box has its shape, as "Fit to the panel" makes it', () => {
    const fitted = fitGameToPanel({ x: 200, y: 100, width: 1200, height: 900 }, 810);
    expect(gameFit(fitted, 810).fills).toBe(true);
    // It stays inside the box it came from.
    expect(fitted.x).toBeGreaterThanOrEqual(200);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(1000);
    const { graph } = buildFilter({ layout: 'facecam', source: landscape, cam, camHeight: 810, game: fitted });
    expect(graph).toContain(`[b]crop=${fitted.width}:${fitted.height}:${fitted.x}:${fitted.y},scale=1080:1110[game]`);
    expect(graph).not.toContain('boxblur');
  });

  it('refuses a content box outside the frame, or with another layout', () => {
    expect(() => buildFilter({ layout: 'facecam', source: landscape, cam, game: { x: 1000, y: 0, width: 1000, height: 500 } })).toThrow(/--game rectangle does not fit/);
    expect(() => buildFilter({ layout: 'center', source: landscape, game: { x: 0, y: 0, width: 100, height: 100 } })).toThrow(/facecam layout/);
  });

  it('refuses a webcam panel height that is odd or outside the limits', () => {
    for (const camHeight of [479, 1154, 811]) {
      expect(() => buildFilter({ layout: 'facecam', source: landscape, cam, camHeight })).toThrow(/even number of pixels from 480 to 1152/);
    }
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

// The logo overlay (a brief from the owner, 2026-11-21).
describe('overlay', () => {
  const logo = (more = {}) => ({ image: '/x/logo.png', imageWidth: 400, imageHeight: 200, kind: 'logo', width: 220, position: 'top-left', margin: 40, offsetY: 0, ...more });

  it('leaves the graph exactly as it was without one', () => {
    for (const layout of ['center', 'blur', 'facecam']) {
      const cam = layout === 'facecam' ? { x: 0, y: 0, width: 480, height: 270 } : undefined;
      expect(buildFilter({ layout, source: landscape, cam, subtitles: true, overlay: null }).graph).toBe(buildFilter({ layout, source: landscape, cam, subtitles: true }).graph);
    }
  });

  it('treats a 400x200 PNG as a logo, scaled to the width, and a 1080x1920 one as the full frame', () => {
    expect(overlayKind(400, 200)).toBe('logo');
    expect(overlayKind(1080, 1920)).toBe('full');
    expect(overlayKind(540, 960)).toBe('full');
    expect(overlayBox(logo())).toEqual({ x: 40, y: 40, width: 220, height: 110 });
    const { graph } = buildFilter({ layout: 'center', source: landscape, subtitles: true, overlay: logo() });
    // After the layout, before the captions, so the captions stay on top.
    expect(graph).toBe('[0:v]fps=30,crop=606:1080:657:0,scale=1080:1920,setsar=1[pre];[1:v]scale=220:-1[lg];[pre][lg]overlay=40:40,subtitles=captions.ass:fontsdir=fonts[v]');
    const full = buildFilter({ layout: 'center', source: landscape, overlay: { ...logo(), imageWidth: 1080, imageHeight: 1920, kind: 'full' } }).graph;
    expect(full).toContain('[1:v]scale=1080:1920[lg];[pre][lg]overlay=0:0[v]');
    expect(overlayBox({ ...logo(), imageWidth: 1080, imageHeight: 1920, kind: 'full' })).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it.each([
    ['top-left', 'overlay=40:40'],
    ['top-right', 'overlay=W-w-40:40'],
    ['bottom-left', 'overlay=40:H-h-40'],
    ['bottom-right', 'overlay=W-w-40:H-h-40'],
  ])('puts the logo %s with %s', (position, expression) => {
    expect(buildFilter({ layout: 'center', source: landscape, overlay: logo({ position }) }).graph).toContain(`[pre][lg]${expression}[v]`);
  });

  it('adds the vertical offset to the height, down or up', () => {
    expect(buildFilter({ layout: 'center', source: landscape, overlay: logo({ offsetY: 660 }) }).graph).toContain('overlay=40:40+660');
    expect(buildFilter({ layout: 'center', source: landscape, overlay: logo({ position: 'bottom-right', offsetY: -100 }) }).graph).toContain('overlay=W-w-40:H-h-40-100');
    expect(overlayBox(logo({ position: 'bottom-right', offsetY: -100 }))).toEqual({ x: 820, y: 1670, width: 220, height: 110 });
  });

  it('takes the input after the end card\'s, and goes over the card too', () => {
    expect(overlayInput(null)).toBe(1);
    expect(overlayInput({ seconds: 3 })).toBe(2);
    expect(overlayInput({ seconds: 3, image: true })).toBe(3);
    const { graph } = buildFilter({ layout: 'center', source: { ...landscape, audioStreams: 0 }, subtitles: true, endCard: { at: 27.5, seconds: 3, image: true }, overlay: logo() });
    expect(graph).toContain("[base][card]overlay=0:0:enable='gte(t,27.5)'[pre];[3:v]scale=220:-1[lg];[pre][lg]overlay=40:40,subtitles=captions.ass:fontsdir=fonts[v]");
  });

  it('warns when the logo covers the captions, the bottom 15% or leaves the frame, and never for a full frame', () => {
    expect(overlayWarnings(logo())).toEqual([]);
    expect(overlayWarnings(logo({ offsetY: 1250 }))).toEqual(['The logo overlaps the captions.']);
    expect(overlayWarnings(logo({ position: 'bottom-left' }))).toEqual(['The logo reaches into the bottom 15% of the frame, which the apps cover with their own text and buttons.']);
    expect(overlayWarnings(logo({ offsetY: -100 }))).toEqual(['Part of the logo is outside the frame.']);
    expect(overlayWarnings({ ...logo({ position: 'bottom-left' }), imageWidth: 1080, imageHeight: 1920, kind: 'full' })).toEqual([]);
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
