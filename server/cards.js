// Matches and their cards, for the card maker page (src/cards/).
import express from 'express';
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
    await saveCardPng(dataDir, req.params.id, req.params.cardId, req.params.size, req.body).catch(asHttp);
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
