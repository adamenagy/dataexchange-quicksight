const express = require('express');
const { authRefreshMiddleware, getExchangeId, createQuickSightDataset } = require('../services/aps.js');

let router = express.Router();

router.use('/api/exchange', authRefreshMiddleware);

router.get('/api/exchange/:exchangeFileVersion', async function (req, res, next) {
  try {
      const exchangeId = await getExchangeId(req.params.exchangeFileVersion, req.internalOAuthToken);
      res.json({ exchangeId });
  } catch (err) {
      next(err);
  }
});

router.post('/api/exchange/:exchangeFileVersion', async function (req, res, next) {
    try {
        await createQuickSightDataset(req.params.exchangeFileVersion, req.internalOAuthToken);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
