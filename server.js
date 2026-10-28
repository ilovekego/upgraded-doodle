require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const transactions = {};
const REQUIRED_AMOUNT = 10000;
const HEROKU_GATEWAY_URL = 'https://apisf-603e3bfe2153.herokuapp.com/finance/mpesa/stkpush';

app.get('/', (req, res) => {
  res.render('index', { price: REQUIRED_AMOUNT });
});

app.post('/api/trigger-stk', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  try {
    const gatewayResponse = await axios.post(HEROKU_GATEWAY_URL, {
      phone: phone,
      amount: REQUIRED_AMOUNT,
      callbackUrl: `${process.env.SERVER_BASE_URL}/api/mpesa-callback`,
      accountReference: 'jaribu'
    });

    const data = gatewayResponse.data;
    const checkoutRequestID = data.CheckoutRequestID || data.checkoutRequestID || data.id || Date.now().toString();

    transactions[checkoutRequestID] = {
      status: 'PENDING',
      amountPaid: 0,
      message: 'Waiting for PIN entry...'
    };

    res.json({ success: true, checkoutRequestID });
  } catch (error) {
    console.error('Gateway Trigger Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to trigger STK Push via gateway' });
  }
});

app.post('/api/mpesa-callback', (req, res) => {
  const callback = req.body.Body?.stkCallback || req.body;
  if (!callback) return res.status(400).send('Invalid payload');

  const checkoutRequestID = callback.CheckoutRequestID;
  const resultCode = callback.ResultCode;

  if (!transactions[checkoutRequestID]) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  if (resultCode !== 0 && resultCode !== undefined) {
    transactions[checkoutRequestID] = {
      status: 'FAILED',
      amountPaid: 0,
      message: 'Transaction canceled or failed.'
    };
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const items = callback.CallbackMetadata?.Item || [];
  const amountPaid = items.find(i => i.Name === 'Amount')?.Value || req.body.amount || 0;
  const mpesaReceipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value || req.body.receipt;

  if (amountPaid < 1000) {
    transactions[checkoutRequestID] = {
      status: 'REJECTED',
      amountPaid,
      message: 'Kijana lipa wacha mchezo!'
    };
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  if (amountPaid < REQUIRED_AMOUNT) {
    transactions[checkoutRequestID] = {
      status: 'UNDERPAID',
      amountPaid,
      message: `Umelipa KES ${amountPaid}, imebaki KES ${REQUIRED_AMOUNT - amountPaid} boss!`
    };
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const secureToken = Buffer.from(`${checkoutRequestID}-${Date.now()}`).toString('base64');
  transactions[checkoutRequestID] = {
    status: 'PAID',
    amountPaid,
    receipt: mpesaReceipt,
    downloadToken: secureToken
  };

  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/api/check-status', (req, res) => {
  const { id } = req.query;
  const tx = transactions[id];
  if (!tx) return res.status(404).json({ status: 'NOT_FOUND' });
  res.json(tx);
});

app.get('/api/download-pdf', (req, res) => {
  const { token, id } = req.query;
  const tx = transactions[id];

  if (!tx || tx.status !== 'PAID' || tx.downloadToken !== token) {
    return res.status(403).send('Kijana lipa wacha mchezo!');
  }

  const filePath = path.join(__dirname, 'secure_storage', 'locked-document.pdf');
  res.download(filePath, 'unlocked-document.pdf');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));