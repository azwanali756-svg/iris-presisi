require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rute utama untuk menyajikan index.html
app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File index.html tidak ditemukan!');
  }
});

app.use(express.static(__dirname));

// Pool Database MySQL Aiven (Wajib untuk Serverless Vercel)
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 13136,
  user: process.env.DB_USER || 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'defaultdb',
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Inisialisasi skema tabel jika belum tersedia
const initDatabase = () => {
  const sqlTelemetry = `
    CREATE TABLE IF NOT EXISTS telemetry_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      soil_moisture FLOAT NOT NULL,
      temperature FLOAT NOT NULL,
      fuzzy_volume_target FLOAT NOT NULL,
      actual_volume_dispensed FLOAT NOT NULL,
      status VARCHAR(50) DEFAULT 'Success'
    );
  `;
  db.query(sqlTelemetry, (errT) => {
    if (!errT) {
      db.query(`ALTER TABLE telemetry_logs ADD COLUMN status VARCHAR(50) DEFAULT 'Success'`, () => {});
    }
  });

  const sqlUsers = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      reset_otp VARCHAR(10) NULL,
      otp_expiry DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;
  db.query(sqlUsers, () => {});
};

initDatabase();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Endpoint Simpan Telemetri / Simulasi Siram
app.post('/api/telemetry', (req, res) => {
  const { soil_moisture, temperature, fuzzy_volume_target, actual_volume_dispensed, status } = req.body;
  const statusLog = status || (fuzzy_volume_target === 0 ? 'SKIPPED_WET' : 'Success');

  const sql = `
    INSERT INTO telemetry_logs 
    (soil_moisture, temperature, fuzzy_volume_target, actual_volume_dispensed, status, timestamp) 
    VALUES (?, ?, ?, ?, ?, NOW())
  `;

  db.query(sql, [soil_moisture, temperature, fuzzy_volume_target, actual_volume_dispensed, statusLog], (err, result) => {
    if (err) {
      console.error('Gagal simpan telemetri:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
    console.log(`[SIMULASI SIRAM] ID: #${result.insertId} | Target: ${fuzzy_volume_target} mL`);
    res.status(201).json({ success: true, insertedId: result.insertId });
  });
});

// Endpoint Riwayat Telemetri
app.get('/api/telemetry/history', (req, res) => {
  const sql = 'SELECT * FROM telemetry_logs ORDER BY timestamp DESC LIMIT 20';
  db.query(sql, (err, rows) => {
    if (err) {
      console.error('Gagal ambil data telemetri:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json(rows);
  });
});

// Endpoint Autentikasi
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const sql = 'SELECT * FROM users WHERE username = ? AND password = ?';
  db.query(sql, [username, password], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    if (rows.length === 0) return res.status(401).json({ success: false, message: 'Username atau password salah' });
    res.json({ success: true, user: rows[0] });
  });
});

app.post('/api/auth/request-otp', (req, res) => {
  const { email } = req.body;
  db.query('SELECT * FROM users WHERE email = ?', [email], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).json({ success: false, message: 'Email tidak ditemukan.' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    db.query('UPDATE users SET reset_otp = ?, otp_expiry = ? WHERE email = ?', [otp, expiry, email], (errUp) => {
      if (errUp) return res.status(500).json({ success: false, message: 'Gagal generate OTP' });

      transporter.sendMail({
        from: `"IrisPresisi" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Kode OTP Reset Password',
        text: `Kode OTP Anda adalah: ${otp}`
      }, (errMail) => {
        if (errMail) return res.status(500).json({ success: false, message: 'Gagal kirim email OTP' });
        res.json({ success: true, message: 'OTP terkirim' });
      });
    });
  });
});

app.post('/api/auth/reset-password-otp', (req, res) => {
  const { email, otp_code, new_password } = req.body;
  const sql = 'SELECT * FROM users WHERE email = ? AND reset_otp = ? AND otp_expiry > NOW()';
  db.query(sql, [email, otp_code], (err, rows) => {
    if (err || rows.length === 0) return res.status(400).json({ success: false, message: 'OTP tidak valid atau kadaluwarsa' });
    db.query('UPDATE users SET password = ?, reset_otp = NULL, otp_expiry = NULL WHERE email = ?', [new_password, email], (errR) => {
      if (errR) return res.status(500).json({ success: false, message: 'Gagal update password' });
      res.json({ success: true, message: 'Password berhasil diubah!' });
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server aktif pada port ${PORT}`);
});

module.exports = app;