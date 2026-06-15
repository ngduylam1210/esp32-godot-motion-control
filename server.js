//==============================================================
// DEBUG
// 1. Mất khối 3D, Không hiện Khối
// - Cổng giao tiếp API - Kết nối với Web - app.get('/api/latest')
// 2. Web vẫn hiển thị dữ liệu số - GG sheet không nhận
// - appendToSheet
// 3. ESP32 không nhận OTA
// - mqttClient.publish('gamefps/command'...) - kiểm tra URL firmware
//==============================================================

const mqtt     = require('mqtt'); // server kết nối với HiveMQ để lắng nghe ESP32
const express  = require('express'); // tạo máy chủ web nhỏ để giao tiếp với trang dashboard
const mongoose = require('mongoose'); // thao tác với CSDL MongoDB
const cors     = require('cors');
const { google } = require('googleapis'); // Server tự động viết vào GGS

// ============================================================
//  GOOGLE SHEETS SETUP
// ============================================================
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
      range:         `${tabName}!A1`, // Ép ghi bắt đầu từ cột A
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
    console.log(`[Sheets] Ghi vao tab ${tabName} OK`);
  } catch (e) {
    console.error(`[Sheets] Loi ghi tab ${tabName}:`, e.message);
  }
}

// Bộ đệm chống ghi quá nhiều
let lastSensorLog = 0;
let lastHealthLog = 0;
const SENSOR_INTERVAL = 10 * 1000;  // 10 giây
const HEALTH_INTERVAL = 300 * 1000;  // 10 phút

// ============================================================
//  EXPRESS
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
//  PARSE MQTT HOST
// - Bóc tách chuỗi mqtts:// của biến môi trường trên Render chỉ lấy đúng IP/Domain và Port của HiveMQ
// ============================================================
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

// ============================================================
//  MONGODB SCHEMAS
// - Quy định dữ liệu nào được phép lưu - bỏ những dữ liệu lạ
// ============================================================
const SensorSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  pitch:     { type: Number, default: 0 },
  roll:      { type: Number, default: 0 },
  yaw:       { type: Number, default: 0 },
  gx:        { type: Number, default: 0 }, 
  gy:        { type: Number, default: 0 }, 
  gz:        { type: Number, default: 0 }, 
  buttons:   { type: Number, default: 0 },
  mode:      { type: Number, default: 0 },
});
SensorSchema.index({ timestamp: -1 });
const SensorData = mongoose.model('SensorData', SensorSchema);

const SessionSchema = new mongoose.Schema({
  timestamp:   { type: Date, default: Date.now },
  sessionId:   String,
  mode:        Number,
  // [ĐÃ XÓA] shootCount, spellCount
  duration:    Number,
  score:       Number,
});
const Session = mongoose.model('Session', SessionSchema);

const HealthSchema = new mongoose.Schema({
  timestamp:   { type: Date, default: Date.now },
  uptime:      Number,
  // [ĐÃ XÓA] voltage, temperature
  rssi:        Number,
  version:     String,
  resetCount:  Number,
});
HealthSchema.index({ timestamp: -1 });
const HealthData = mongoose.model('HealthData', HealthSchema);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('[DB] MongoDB connected'))
  .catch(err => console.error('[DB] Loi:', err.message));

// ============================================================
//  MQTT
// - Khi vừa kết nối với HiveMQ - nó sẽ đăng ký (subscribe) lắng nghe 4 kênh topic của dự án
// ============================================================
const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}`, {
  port:               MQTT_PORT,
  username:           process.env.MQTT_USER,
  password:           process.env.MQTT_PASS,
  rejectUnauthorized: false,
  reconnectPeriod:    3000,
  keepalive:          60,
});

mqttClient.on('connect', () => {
  console.log('[MQTT] Ket noi HiveMQ OK!');
  mqttClient.subscribe('gamefps/controller', { qos: 0 });
  mqttClient.subscribe('gamefps/command',    { qos: 1 });
  mqttClient.subscribe('gamefps/session',    { qos: 0 });
  mqttClient.subscribe('gamefps/health',     { qos: 0 });
  mqttClient.subscribe('gamefps/ota_status', { qos: 1 });
});

mqttClient.on('error',     err => console.error('[MQTT] Loi:', err.message));
mqttClient.on('reconnect', ()  => console.log('[MQTT] Dang ket noi lai...'));
mqttClient.on('offline',   ()  => console.warn('[MQTT] Offline'));

// Giới hạn lưu DB
let lastSaved = 0;

mqttClient.on('message', async (topic, message) => {
  let data;
  try { data = JSON.parse(message.toString()); }
  catch { return; }

  //-----------------
  // ── CONTROLLER
  // - Chỉ lưu vào MongoDB tối đa 2 lần/s
  //-----------------
  if (topic === 'gamefps/controller') {
    const now = Date.now();

    // Rate limit lưu DB: 2 lần/giây
    if (now - lastSaved >= 500) {
      lastSaved = now;
      try {
        await SensorData.create({
          pitch:   parseFloat(data.pitch)   || 0,
          roll:    parseFloat(data.roll)    || 0,
          yaw:     parseFloat(data.yaw)     || 0,
          gx:      parseFloat(data.gx)      || 0, // Đã thêm
          gy:      parseFloat(data.gy)      || 0, // Đã thêm
          gz:      parseFloat(data.gz)      || 0, // Đã thêm
          buttons: parseInt(data.buttons)   || 0,
          mode:    parseInt(data.mode)      || 0,
        });
      } catch (e) { console.error('[DB Controller]', e.message); }
    }

    // GHI GOOGLE SHEETS
    const nowSheets = Date.now();
    if (nowSheets - lastSensorLog >= SENSOR_INTERVAL) {
      lastSensorLog = nowSheets;
      const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      
      // CHỈ GHI: TimeStamp, Pitch, Roll, Yaw, GyroX, GyroY, GyroZ
      appendToSheet('SensorLog', [
        ts,
        parseFloat(data.pitch).toFixed(2),
        parseFloat(data.roll).toFixed(2),
        parseFloat(data.yaw).toFixed(2),
        data.gx || 0,
        data.gy || 0,
        data.gz || 0
      ]);
    }
  }

  // ── SESSION
  if (topic === 'gamefps/session') {
    try {
      await Session.create(data);
      
      // Ghi thêm vào Sheets khi nhận qua MQTT
      const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      // CHỈ GHI: TimeStamp, SessionID, Mode, Duration  [ĐÃ XÓA ShootCount, SpellCount]
      appendToSheet('SessionLog', [
        ts,
        data.sessionId  || 'N/A',
        data.mode       || 1,
        data.duration   || 0
      ]);
    } catch (e) { console.error('[DB Session]', e.message); }
  }

  // ── HEALTH
  if (topic === 'gamefps/health') {
    try {
      await HealthData.create({
        uptime:      data.uptime      || 0,
        // [ĐÃ XÓA] voltage, temperature
        rssi:        data.rssi        || 0,
        version:     data.version     || '',
        resetCount:  data.resetCount  || 0,
      });
    } catch (e) { console.error('[DB Health]', e.message); }

    const nowH = Date.now();
    if (nowH - lastHealthLog >= HEALTH_INTERVAL) {
      lastHealthLog = nowH;
      const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      
      // CHỈ GHI: TimeStamp, WiFi RSSI, Uptime  [ĐÃ XÓA Temp]
      appendToSheet('HealthLog', [
        ts,
        data.rssi        || 0,
        data.uptime      || 0
      ]);
    }
  }

  // ── OTA STATUS
  if (topic === 'gamefps/ota_status') {
    console.log(`[OTA] ESP32 bao cao: ${JSON.stringify(data)}`);
    latestOtaStatus = data;
  }
});

// ============================================================
//  BIẾN LƯU TRẠNG THÁI OTA
// ============================================================
let latestOtaStatus = { status: 'idle', message: '', ts: 0 };

// ============================================================
//  API ENDPOINTS
// ============================================================

// Lấy dữ liệu cảm biến mới nhất
app.get('/api/latest', async (req, res) => {
  try {
    const d = await SensorData.findOne().sort({ timestamp: -1 }).lean();
    res.json(d || { pitch: 0, roll: 0, yaw: 0, buttons: 0, mode: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lịch sử 50 mẫu gần nhất
app.get('/api/history', async (req, res) => {
  try {
    const records = await SensorData.find().sort({ timestamp: -1 }).limit(50).lean();
    res.json(records.reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Danh sách session
app.get('/api/sessions', async (req, res) => {
  try {
    res.json(await Session.find().sort({ timestamp: -1 }).limit(50));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Thống kê
app.get('/api/stats', async (req, res) => {
  try {
    const total = await Session.countDocuments();
    const top   = await Session.findOne().sort({ score: -1 }).lean();
    res.json({ total, topScore: top?.score || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health data
app.get('/api/health', async (req, res) => {
  try {
    const h = await HealthData.findOne().sort({ timestamp: -1 }).lean();
    if (!h) return res.json({ mqttConnected: mqttClient.connected });
    res.json({ ...h, mqttConnected: mqttClient.connected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ghi session thủ công
app.post('/api/log-session', async (req, res) => {
  try {
    const { mode, duration, score } = req.body; // [ĐÃ XÓA] shootCount, spellCount
    const ts        = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const sessionId = Date.now().toString(36).toUpperCase();

    await Session.create({ sessionId, mode, duration, score });

    // CHỈ GHI: TimeStamp, SessionID, Mode, Duration
    appendToSheet('SessionLog', [
      ts, 
      sessionId,
      mode       || 1,
      duration   || 0
    ]);

    res.json({ ok: true, sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trigger OTA
app.post('/api/trigger-ota', (req, res) => {
  latestOtaStatus = {
    status:  'pending',
    message: 'Lenh OTA da gui - cho ESP32 xac nhan...',
    ts:      Date.now()
  };

  mqttClient.publish(
    'gamefps/command',
    JSON.stringify({
      command:     'START_OTA',
      firmwareUrl: 'https://raw.githubusercontent.com/ngduylam1210/GameFPS-Server/main/firmware.bin',
      ts:          Date.now()
    }),
    { qos: 1 },
    (err) => {
      if (err) {
        latestOtaStatus = { status: 'error', message: err.message, ts: Date.now() };
        return res.status(500).json({ message: 'Loi gui lenh: ' + err.message });
      }
      console.log('[OTA] Lenh START_OTA da gui');
      res.json({
        message: 'Lenh OTA da gui! ESP32 se mat ket noi ~30-60 giay trong khi cap nhat.',
        note:    'ESP32 ban flash firmware, khong the gui du lieu.',
        status:  'pending'
      });
    }
  );
});

// Endpoint cho web polling trạng thái OTA
app.get('/api/ota-status', (req, res) => {
  res.json(latestOtaStatus);
});

// ============================================================
//  KHỞI ĐỘNG
// ============================================================
app.listen(process.env.PORT || 3000, () =>
  console.log(`[API] Server chay tren port ${process.env.PORT || 3000}`));
