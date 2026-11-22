// Ready-made event terms the owner can start from and change.

/** @type {Record<string, { name: string, groups: import('./terms.js').TermGroup[] }>} */
export const PRESETS = {
  football: {
    name: 'Football',
    groups: [
      { label: 'Goal', terms: ['goal', 'gol', 'golazo', 'what a goal', 'scores', 'scored'] },
      { label: 'Penalty', terms: ['penalty', 'pen', 'penal', 'spot kick'] },
      // "red" on its own is left out on purpose: chat says it about shirts,
      // teams and much else, and it gave too many false hits.
      { label: 'Red card', terms: ['red card', 'sent off', 'roja', 'straight red'] },
      { label: 'VAR', terms: ['var', 'check', 'overturned', 'video ref'] },
      { label: 'Offside', terms: ['offside', 'fuera de juego'] },
      { label: 'Save', terms: ['save', 'what a save', 'keeper', 'parada'] },
    ],
  },
  gaming: {
    name: 'Gaming',
    groups: [
      { label: 'Clip', terms: ['clip', 'clip it', 'clip that'] },
      { label: 'LOL', terms: ['lol', 'lmao', 'lmfao', 'haha', 'kekw'] },
      { label: 'OMG', terms: ['omg', 'oh my god'] },
      { label: 'No way', terms: ['no way', 'nah', 'wtf'] },
      { label: 'W', terms: ['w', 'dub', 'huge w'] },
      { label: 'Fail', terms: ['fail', 'l', 'rip', 'f'] },
    ],
  },
};
