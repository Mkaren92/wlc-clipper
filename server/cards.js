// Matches and their cards, for the card maker page (src/cards/).
import express from 'express';
import { readLibrary, removeClub, removeLeague, saveClub, saveLeague } from '../src/cards/clubs.js';
import { cardPngPath, deleteMatch, isCardSize, isId, listMatches, newMatchId, readMatch, saveCardPng, saveMatch } from '../src/cards/match.js';
import { HttpError } from './http.js';

/**
 * @param {import('express').Express} app
 * @param {{ dataDir: string }} options
 */
export function addCardRoutes(app, { dataDir }) {
  // "No such match" is the person's mistake in the address; anything else is in what they sent.
  const asHttp = (error) => {
    throw new HttpError(/^No such/.test(error.message) ? 404 : 400, error.message);
  };

  // --- Leagues and clubs (src/cards/clubs.js) --------------------------------
  // Every change answers with the whole list, so the page never has to piece it together.

  app.get('/api/clubs', async (req, res) => res.json(await readLibrary(dataDir)));

  app.post('/api/leagues', async (req, res) => {
    res.status(201).json(await saveLeague(dataDir, { name: req.body?.name }).catch(asHttp));
  });
  app.put('/api/leagues/:id', async (req, res) => {
    res.json(await saveLeague(dataDir, { id: req.params.id, name: req.body?.name }).catch(asHttp));
  });
  // Deleting a league deletes its clubs with it. The page says so before asking.
  app.delete('/api/leagues/:id', async (req, res) => {
    res.json(await removeLeague(dataDir, req.params.id).catch(asHttp));
  });

  // Only these four things can be set on a club; its id is made here from its name.
  const clubFields = ({ name, league, colour, icon } = {}) => Object.fromEntries(Object.entries({ name, league, colour, icon }).filter(([, value]) => value !== undefined));
  app.post('/api/clubs', async (req, res) => {
    res.status(201).json(await saveClub(dataDir, clubFields(req.body)).catch(asHttp));
  });
  app.put('/api/clubs/:id', async (req, res) => {
    res.json(await saveClub(dataDir, { ...clubFields(req.body), id: req.params.id }).catch(asHttp));
  });
  app.delete('/api/clubs/:id', async (req, res) => {
    res.json(await removeClub(dataDir, req.params.id).catch(asHttp));
  });

  // --- Matches -----------------------------------------------------------------

  app.get('/api/matches', async (req, res) => res.json(await listMatches(dataDir)));

  // A new match gets its id from the team names.
  app.post('/api/matches', async (req, res) => {
    const id = await newMatchId(dataDir, String(req.body?.home ?? ''), String(req.body?.away ?? ''));
    res.status(201).json(await saveMatch(dataDir, { ...req.body, id }).catch(asHttp));
  });

  app.put('/api/matches/:id', async (req, res) => {
    await readMatch(dataDir, req.params.id).catch(asHttp);
    res.json(await saveMatch(dataDir, { ...req.body, id: req.params.id }).catch(asHttp));
  });

  app.delete('/api/matches/:id', async (req, res) => {
    await deleteMatch(dataDir, req.params.id).catch(asHttp);
    res.json({ ok: true });
  });

  // The page draws each card as a PNG and sends it here, so that the
  // compilation builder has the picture ffmpeg needs.
  app.put('/api/matches/:id/cards/:cardId/png/:size', express.raw({ type: 'image/png', limit: '12mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Send the picture as image/png.');
    // ?clear=1 marks the picture with the see-through background, for a card that lies over a video.
    await saveCardPng(dataDir, req.params.id, req.params.cardId, req.params.size, req.body, req.query.clear === '1').catch(asHttp);
    res.json({ ok: true });
  });

  app.get('/media/cards/:id/:cardId/:size', (req, res) => {
    const { id, cardId, size } = req.params;
    if (!isId(id) || !isId(cardId) || !isCardSize(size)) throw new HttpError(404, 'No such card.');
    res.set('Cache-Control', 'no-store');
    res.sendFile(cardPngPath(dataDir, id, cardId, size), { cacheControl: false }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'This card has no picture yet. Open it in the card maker and save it.' });
    });
  });
}
