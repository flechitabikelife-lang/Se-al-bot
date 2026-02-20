
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// FIREBASE - lee desde variable de entorno de Railway
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

let sock = null;
let qrCodeBase64 = null;
let botStatus = 'desconectado';
let groupId = null;
let signalInterval = null;

async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeBase64 = await QRCode.toDataURL(qr);
      botStatus = 'esperando_qr';
    }
    if (connection === 'close') {
      botStatus = 'desconectado';
      qrCodeBase64 = null;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(conectarWhatsApp, 3000);
    }
    if (connection === 'open') {
      botStatus = 'conectado';
      qrCodeBase64 = null;
      await db.collection('bot').doc('estado').set({
        status: 'conectado',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

app.get('/api/status', (req, res) => {
  res.json({ status: botStatus, qr: qrCodeBase64, groupId });
});

app.post('/api/conectar', async (req, res) => {
  if (botStatus === 'conectado') return res.json({ ok: false, msg: 'Ya conectado' });
  await conectarWhatsApp();
  res.json({ ok: true, msg: 'Iniciando...' });
});

app.post('/api/desconectar', async (req, res) => {
  if (sock) { await sock.logout(); sock = null; botStatus = 'desconectado'; }
  detenerSenales();
  res.json({ ok: true, msg: 'Bot desconectado' });
});

app.get('/api/grupos', async (req, res) => {
  if (!sock || botStatus !== 'conectado') return res.json({ ok: false, msg: 'Bot no conectado' });
  const chats = await sock.groupFetchAllParticipating();
  const grupos = Object.values(chats).map(g => ({ id: g.id, nombre: g.subject }));
  res.json({ ok: true, grupos });
});

app.post('/api/grupo', async (req, res) => {
  groupId = req.body.id;
  await db.collection('bot').doc('config').set({ groupId }, { merge: true });
  res.json({ ok: true, msg: 'Grupo configurado' });
});

app.post('/api/enviar', async (req, res) => {
  if (!sock || botStatus !== 'conectado') return res.json({ ok: false, msg: 'Bot no conectado' });
  if (!groupId) return res.json({ ok: false, msg: 'Sin grupo configurado' });
  await sock.sendMessage(groupId, { text: req.body.mensaje });
  await db.collection('senales').add({
    mensaje: req.body.mensaje,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    tipo: 'manual'
  });
  res.json({ ok: true, msg: 'Señal enviada!' });
});

app.post('/api/automatico/iniciar', (req, res) => {
  const { mensaje, intervaloMinutos } = req.body;
  if (!sock || botStatus !== 'conectado') return res.json({ ok: false, msg: 'Bot no conectado' });
  if (!groupId) return res.json({ ok: false, msg: 'Sin grupo configurado' });
  detenerSenales();
  signalInterval = setInterval(async () => {
    await sock.sendMessage(groupId, { text: mensaje });
    await db.collection('senales').add({
      mensaje,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      tipo: 'automatica'
    });
  }, (intervaloMinutos || 5) * 60 * 1000);
  res.json({ ok: true, msg: `Señales cada ${intervaloMinutos} minutos iniciadas` });
});

app.post('/api/automatico/detener', (req, res) => {
  detenerSenales();
  res.json({ ok: true, msg: 'Señales automáticas detenidas' });
});

app.get('/api/historial', async (req, res) => {
  const snap = await db.collection('senales').orderBy('timestamp', 'desc').limit(50).get();
  const senales = snap.docs.map(doc => ({
    id: doc.id, ...doc.data(),
    timestamp: doc.data().timestamp?.toDate?.()?.toLocaleString('es-CO') || 'Sin fecha'
  }));
  res.json({ ok: true, senales });
});

function detenerSenales() {
  if (signalInterval) { clearInterval(signalInterval); signalInterval = null; }
}

app.listen(process.env.PORT || 3000, () => console.log('Servidor corriendo'));
