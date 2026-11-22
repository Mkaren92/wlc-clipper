// Moments viewers pointed to in a video's comments: "10:00:01 bro started panic",
// "9:59:42 THE ONE SHOWER SCENE". Viewers' own picks are the strongest sign of a
// moment worth clipping; several people pointing at the same seconds, more so.
//
// Added on 2026-11-21: on the owner's 11-hour stream, three of its 52 top comments
// pointed at 9:59:42 to 10:00:01, and none of the five clips chosen from chat
// volume was near it. Comments are outside text: only their words and like counts
// are used, never who wrote them. Pure: no Node imports.

// A time as people write it: 1:02:03, 12:34, 3:45:40. Not part of a longer number or a ratio.
const TIME = /(?<![\d:.])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/g;
// Marks this close together are the same moment.
const SAME_MOMENT_SECONDS = 25;
// A comment with more times than this is a chapter list ("0:00 Intro, 12:30 Game 1, ..."):
// it says where things are, not which moment is worth clipping, so its marks share one
// comment's weight between them instead of each counting as a viewer pointing there.
const CHAPTER_LIST_TIMES = 3;

/**
 * Every timestamp in the comments, with the comment's likes and a one-line text.
 *
 * @param {Array<{ text: string, likes?: number }>} comments
 * @param {number} duration   seconds; later times are left out
 * @returns {Array<{ t: number, likes: number, text: string, share: number }>}
 *   `share` is 1, or 1/n for each of the n times of a chapter list
 */
export function commentMarks(comments, duration) {
  const marks = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const text = String(comment?.text ?? '').replace(/\s+/g, ' ').trim();
    const likes = Number.isFinite(comment?.likes) && comment.likes > 0 ? comment.likes : 0;
    const seen = []; // times already taken from this comment
    for (const match of text.matchAll(TIME)) {
      const [, a, b, c] = match;
      if (Number(b) > 59 || (c !== undefined && Number(c) > 59)) continue;
      const t = c !== undefined ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
      // A comment that lists many times (a chapter list) still counts once per moment.
      if (t > duration || seen.some((other) => Math.abs(other - t) <= SAME_MOMENT_SECONDS)) continue;
      seen.push(t);
    }
    const share = seen.length > CHAPTER_LIST_TIMES ? 1 / seen.length : 1;
    for (const t of seen) marks.push({ t, likes, text: text.slice(0, 120), share });
  }
  return marks.sort((a, b) => a.t - b.t);
}

/**
 * The marks gathered into moments: marks within 25 s of each other are one.
 * A moment's weight is how many comments point at it, plus a little for likes; a chapter
 * list's mark counts as its share of one comment. `pointers` is that count, which is what
 * "two or more comments point here" is judged on.
 *
 * @param {Array<{ t: number, likes: number, text: string, share?: number }>} marks
 * @returns {Array<{ at: number, until: number, marks: number, pointers: number, likes: number, weight: number, texts: string[] }>}
 */
export function commentMoments(marks) {
  const moments = [];
  for (const mark of marks) {
    const last = moments.at(-1);
    if (last && mark.t - last.items.at(-1).t <= SAME_MOMENT_SECONDS) last.items.push(mark);
    else moments.push({ items: [mark] });
  }
  return moments.map(({ items }) => {
    // People write the time just before the moment, so the earliest mark is where it starts.
    const likes = items.reduce((sum, item) => sum + item.likes, 0);
    const share = (item) => item.share ?? 1;
    const pointers = items.reduce((sum, item) => sum + share(item), 0);
    return {
      at: items[0].t,
      // The last mark: a moment several comments point to runs to the latest of their times.
      until: items.at(-1).t,
      marks: items.length,
      pointers,
      likes,
      weight: pointers + items.reduce((sum, item) => sum + share(item) * Math.log10(1 + item.likes), 0),
      texts: [...items].sort((a, b) => b.likes - a.likes).slice(0, 3).map((item) => item.text),
    };
  });
}
