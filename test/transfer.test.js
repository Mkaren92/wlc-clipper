// What the owner's travelling data is: the one list that sync sends and takes back
// (src/transfer/contents.js). Sync itself is tested in sync.test.js.
import { describe, expect, it } from 'vitest';
import { acceptEntry } from '../src/transfer/contents.js';

describe('what counts as the owner\'s data', () => {
  it('takes what the owner chose to carry: the lists, pictures, sounds and briefs', () => {
    for (const name of [
      'data/sources.json', 'data/clubs.json', 'data/source-subscribers.json', 'data/source-pictures/north-stand.png',
      'sounds/goal.mp3', 'sounds/intro.mp4', 'briefs/mine.json', 'overlays/kreek-logo.webp', 'overlays/logo.png',
    ]) expect(acceptEntry(name), name).toBe(true);
  });

  it('leaves the rest on the machine: videos, clips, combinations, compilations, matches and cards', () => {
    for (const name of [
      'in/a video.mp4', 'parts/a_1m00s-1m30s.mp4', 'out/first-clip/clip.mp4', 'out/first-clip/work/meta.json',
      'data/combinations/goal/combination.json', 'data/combinations/goal/combined.mp4',
      'data/compilations/reactions/timeline.json', 'data/compilations/reactions/final.mp4',
      'data/matches/home-v-away/match.json', 'data/matches/home-v-away/cards/c1-landscape.png',
    ]) expect(acceptEntry(name), name).toBe(false);
  });

  it('never takes the key, the backups, code, or a name that is not a plain file in its folder', () => {
    for (const name of [
      'data/backups/sources/x.json', 'data/sounds-made/goal-v2.wav', 'data/clubs.before-something.json', 'data/.incoming/files/data/sources.json',
      'env', '.env', 'package.json', 'src/cli.js', 'server/app.js', 'sounds/readme.txt', 'sounds/sub/goal.mp3', 'briefs/notes.txt',
      'overlays/logo.webp:Zone.Identifier', 'overlays/sub/logo.png', 'overlays/notes.txt', 'data/youtube-cookies.txt',
      'data/source-pictures/../../x.png', 'data/sources.json/x',
    ]) expect(acceptEntry(name), name).toBe(false);
  });
});
