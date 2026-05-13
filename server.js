const mqtt     = require('mqtt');
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const { google } = require('googleapis');

//=======================================================================
// ── Google Sheets setup
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key:  process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function appendToSheet(tabName, values) {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range:         `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
  } catch (e) {
    console.error(`[Sheets] Lỗi ghi tab ${tabName}:`, e.message);
  }
}

// ── Bộ đệm chống ghi quá nhiều
let lastSensorLog = 0;   // ghi mỗi 10 giây
let lastHealthLog = 0;   // ghi mỗi 30 giây
const SENSOR_INTERVAL = 10 * 1000;
const HEALTH_INTERVAL = 600 * 1000;
//==================================================================

const app = express();
app.use(cors());
app.use(express.json());

// ── FIX: Parse MQTT_HOST linh hoạt (Render env có thể chứa mqtts://...host...:8883)
function parseMqttHost(raw) {
  try {
    const url = new URL(raw.includes('://') ? raw : 'mqtts://' + raw);
    return { host: url.hostname, port: url.port ? parseInt(url.port) : 8883 };
  } catch {
    return { host: raw, port: 8883 };
  }
}
const mqttEnv   = parseMqttHost(process.env.MQTT_HOST || '');
const MQTT_HOST = mqttEnv.host;
const MQTT_PORT = parseInt(process.env.MQTT_PORT) || mqttEnv.port || 8883;
console.log(`[MQTT] Host: ${MQTT_HOST}  Port: ${MQTT_PORT}`);

// ── 1. Schema Cảm biến
const SensorSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  pitch:   { type: Number, default: 0 },
  roll:    { type: Number, default: 0 },
  yaw:     { type: Number, default: 0 },
  buttons: { type: Number, default: 0 },
  mode:    { type: Number, default: 0 },
});
SensorSchema.index({ timestamp: -1 });
const SensorData = mongoose.model('SensorData', SensorSchema);

// ── 2. Schema Session (Phiên chơi game)
const SessionSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  score: Number, duration: Number,
});
const Session = mongoose.model('Session', SessionSchema);

// ── 3. Schema Sức khỏe Phần cứng (Health)
const HealthSchema = new mongoose.Schema({
  timestamp:     { type: Date, default: Date.now },
  uptime:        Number,   // giây
  voltage:       Number,   // volt pin 18650
  temperature:   Number,   // °C lõi ESP32
  rssi:          Number,   // dBm WiFi
  resetCount:    Number,
});
HealthSchema.index({ timestamp: -1 });
const HealthData = mongoose.model('HealthData', HealthSchema);

// ── Kết nối MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('[DB] MongoDB connected'))
  .catch(err => console.error('[DB] Lỗi:', err.message));

// ── Kết nối HiveMQ TLS
const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}`, {
  port: MQTT_PORT,
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: false,
  reconnectPeriod: 3000,
});

mqttClient.on('connect', () => {
  console.log('[MQTT] Kết nối HiveMQ OK!');
  mqttClient.subscribe('gamefps/controller', { qos: 0 });
  mqttClient.subscribe('gamefps/command',    { qos: 1 });
  mqttClient.subscribe('gamefps/session',    { qos: 0 });
  mqttClient.subscribe('gamefps/health',     { qos: 0 });
});

mqttClient.on('error', err => console.error('[MQTT] Lỗi:', err.message));
mqttClient.on('reconnect', () => console.log('[MQTT] Đang kết nối lại...'));

// Giới hạn lưu DB 10 lần/giây và CHỐNG TRÙNG LẶP
let lastSaved = 0;
let lastDataString = ""; 

mqttClient.on('message', async (topic, message) => {
  const rawMsg = message.toString();
  let data;
  try { data = JSON.parse(rawMsg); }
  catch { return; }

  const currentTime = Date.now(); // Sử dụng chung 1 biến thời gian cho toàn bộ sự kiện

  // ==========================================
  // XỬ LÝ CONTROLLER TOPIC
  // ==========================================
  if (topic === 'gamefps/controller') {
    
    // 1. GHI GOOGLE SHEETS LUÔN LUÔN CHẠY MỖI 10 GIÂY (Không bị chặn bởi lastDataString)
    if (currentTime - lastSensorLog >= SENSOR_INTERVAL) {
      lastSensorLog = currentTime;
      const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      appendToSheet('SensorLog', [
        ts,
        parseFloat(data.pitch).toFixed(2),
        parseFloat(data.roll).toFixed(2),
        parseFloat(data.yaw).toFixed(2),
        data.gx || 0, // Lấy giá trị gx từ data
        data.gy || 0, // Lấy giá trị gy từ data
        data.gz || 0  // Lấy giá trị gz từ data
      ]);
    }

    // 2. CHỐNG SPAM DATABASE MONGODB (Chỉ lưu khi mạch có cử động)
    if (rawMsg === lastDataString) return; // Nếu nằm im, thoát ngay không ghi DB
    if (currentTime - lastSaved < 100) return; // rate limit: 10Hz
    
    lastSaved = currentTime;
    lastDataString = rawMsg;
    
    try {
      await SensorData.create({
        pitch:   parseFloat(data.pitch)   || 0,
        roll:    parseFloat(data.roll)    || 0,
        yaw:     parseFloat(data.yaw)     || 0,
        buttons: parseInt(data.buttons)   || 0,
        mode:    parseInt(data.mode)      || 0,
      });
    } catch (e) { console.error('[DB Controller]', e.message); }
  }

  // ==========================================
  // XỬ LÝ SESSION TOPIC
  // ==========================================
  if (topic === 'gamefps/session') {
    try { 
      await Session.create(data); 
      
      const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      await appendToSheet('SessionLog', [
        ts, 
        data.sessionId || 'N/A', 
        data.score || 0, 
        data.duration || 0
      ]);
      
    } catch (e) { console.error('[DB Session]', e.message); }
  }

  // ==========================================
  // XỬ LÝ HEALTH TOPIC
  // ==========================================
  if (topic === 'gamefps/health') {
    try {
      await HealthData.create({
        uptime:      data.uptime      || 0,
        voltage:     data.voltage     || 0,
        temperature: data.temperature || 0,
        rssi:        data.rssi        || 0,
        version:     data.version     || '',
        resetCount:  data.resetCount  || 0,
      });
    } catch (e) { console.error('[DB Health]', e.message); }
      
    // Ghi vào Google Sheets
    if (currentTime - lastHealthLog >= HEALTH_INTERVAL) {
      lastHealthLog = currentTime;
      const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      appendToSheet('HealthLog', [
        ts,
        data.voltage,
        data.temperature,
        data.rssi,
        data.uptime,
        data.version || '2.4'
      ]);
    }
  }
});

// ── API ENDPOINTS ──
app.get('/api/latest', async (req, res) => {
  try {
    const d = await SensorData.findOne().sort({ timestamp: -1 }).lean();
    res.json(d || { pitch: 0, roll: 0, yaw: 0, buttons: 0, mode: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (req, res) => {
  try {
    const records = await SensorData.find().sort({ timestamp: -1 }).limit(50).lean();
    res.json(records.reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions', async (req, res) => {
  try { res.json(await Session.find().sort({ timestamp: -1 }).limit(50)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const total = await Session.countDocuments();
    const top   = await Session.findOne().sort({ score: -1 }).lean();
    res.json({ total, topScore: top?.score || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => {
  try {
    const h = await HealthData.findOne().sort({ timestamp: -1 }).lean();
    if (!h) return res.json({ mqttConnected: mqttClient.connected });
    res.json({
      ...h,
      mqttConnected: mqttClient.connected
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lệnh OTA
app.post('/api/trigger-ota', (req, res) => {
  mqttClient.publish('gamefps/command',
    JSON.stringify({ command: 'START_OTA', ts: Date.now() }),
    { qos: 1 },
    (err) => {
      if (err) return res.status(500).json({ message: 'Lỗi: ' + err.message });
      res.json({ message: 'Lệnh OTA đã gửi! ESP32 sẽ tự cập nhật.' });
    }
  );
});

// ── API ghi phiên chơi (gọi từ Godot hoặc tay)
app.post('/api/log-session', async (req, res) => {
  try {
    const { mode, shootCount, spellCount, duration } = req.body;
    const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const sessionId = Date.now().toString(36).toUpperCase();

    await appendToSheet('SessionLog', [
      ts, sessionId,
      mode        || 1,
      shootCount  || 0,
      spellCount  || 0,
      duration    || 0
    ]);

    res.json({ ok: true, sessionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Khởi chạy Server
app.listen(process.env.PORT || 3000, () =>
  console.log(`[API] Server port ${process.env.PORT || 3000}`)
);
