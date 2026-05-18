require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const { Pool }   = require('pg');
const nodemailer = require('nodemailer');
const bcrypt     = require('bcryptjs');
const path       = require('path');

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Middleware ───
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret_cambiar',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Nodemailer ───
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

// ─── Middleware de autenticacion ───
function requireAuth(req, res, next) {
  if (req.session.auth) return next();
  res.redirect('/');
}

// ─── Inicializar DB ───
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historial_alarmas (
      id SERIAL PRIMARY KEY,
      dispositivo_id VARCHAR(50) NOT NULL,
      evento VARCHAR(100) NOT NULL,
      fecha_hora TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Base de datos lista');
}

// ══════════════════════════════════════
//  RUTAS
// ══════════════════════════════════════

// ─── GET / — Login ───
app.get('/', (req, res) => {
  if (req.session.auth) return res.redirect('/panel');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// ─── POST /login ───
app.post('/login', async (req, res) => {
  const { usuario, clave } = req.body;
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'password';

  if (usuario === adminUser && clave === adminPass) {
    req.session.auth = true;
    return res.redirect('/panel');
  }
  res.redirect('/?error=1');
});

// ─── GET /logout ───
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── GET /panel ───
app.get('/panel', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'panel.html'));
});

// ─── GET /api/datos — Datos en tiempo real ───
app.get('/api/datos', requireAuth, async (req, res) => {
  try {
    const [rows, total, hoy, ultima, grafica] = await Promise.all([
      pool.query('SELECT * FROM historial_alarmas ORDER BY fecha_hora DESC LIMIT 50'),
      pool.query('SELECT COUNT(*) FROM historial_alarmas'),
      pool.query("SELECT COUNT(*) FROM historial_alarmas WHERE DATE(fecha_hora) = CURRENT_DATE"),
      pool.query('SELECT fecha_hora FROM historial_alarmas ORDER BY fecha_hora DESC LIMIT 1'),
      pool.query(`
        SELECT DATE(fecha_hora) as dia, COUNT(*) as total
        FROM historial_alarmas
        WHERE fecha_hora >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(fecha_hora)
        ORDER BY dia ASC
      `)
    ]);

    res.json({
      rows:    rows.rows,
      total:   total.rows[0].count,
      hoy:     hoy.rows[0].count,
      ultima:  ultima.rows[0]?.fecha_hora || null,
      grafica: grafica.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /log_alarm — Endpoint para el ESP32 ───
app.post('/log_alarm', async (req, res) => {
  const { key, dispositivo, evento } = req.body;

  // Validar token
  if (key !== process.env.SECRET_KEY) {
    return res.status(403).send('Acceso denegado');
  }

  const disp  = (dispositivo || 'esp32_nano').substring(0, 50);
  const event = (evento || 'Sensor HC-SR04 Activado').substring(0, 100);

  try {
    // Guardar en DB
    await pool.query(
      'INSERT INTO historial_alarmas (dispositivo_id, evento) VALUES ($1, $2)',
      [disp, event]
    );

    // Enviar correo
    await transporter.sendMail({
      from:    `"Sistema Alarma" <${process.env.GMAIL_USER}>`,
      to:      process.env.CORREO_DESTINO,
      subject: `⚠️ Alerta detectada — ${new Date().toLocaleString('es-MX')}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:12px">
          <h2 style="color:#e05c5c;margin:0 0 16px">⚠️ Alerta de seguridad</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px;color:#555;font-size:14px">Dispositivo</td>
                <td style="padding:8px;font-weight:bold;font-size:14px">${disp}</td></tr>
            <tr style="background:#fff"><td style="padding:8px;color:#555;font-size:14px">Evento</td>
                <td style="padding:8px;font-weight:bold;font-size:14px">${event}</td></tr>
            <tr><td style="padding:8px;color:#555;font-size:14px">Fecha y hora</td>
                <td style="padding:8px;font-weight:bold;font-size:14px">${new Date().toLocaleString('es-MX')}</td></tr>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#999">Sistema de alarma ESP32 Nano + HC-SR04</p>
        </div>
      `
    });

    res.send('OK');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error: ' + e.message);
  }
});

// ─── Arrancar servidor ───
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
