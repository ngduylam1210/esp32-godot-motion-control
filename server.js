const mqtt     = require('mqtt');
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');

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

// ── Schema cảm biến (FIX: trước đây thiếu hoàn toàn)
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

const SessionSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  score: Number, duration: Number,
});
const Session = mongoose.model('Session', SessionSchema);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('[DB] MongoDB connected'))
  .catch(err => console.error('[DB] Lỗi:', err.message));

// ── 1. THÊM Schema (sau SessionSchema)
const HealthSchema = new mongoose.Schema({
  timestamp:     { type: Date, default: Date.now },
  uptime:        Number,   // giây
  voltage:       Number,   // volt pin 18650
  temperature:   Number,   // °C lõi ESP32
  rssi:          Number,   // dBm WiFi
  version:       String,   // firmware version
  resetCount:    Number,
});
HealthSchema.index({ timestamp: -1 });
const HealthData = mongoose.model('HealthData', HealthSchema);

// ── 1. HeathSchema
const HealthSchema = new mongoose.Schema({
  timestamp:     { type: Date, default: Date.now },
  uptime:        Number,   // giây
  voltage:       Number,   // volt pin 18650
  temperature:   Number,   // °C lõi ESP32
  rssi:          Number,   // dBm WiFi
  version:       String,   // firmware version
  resetCount:    Number,
});
HealthSchema.index({ timestamp: -1 });
const HealthData = mongoose.model('HealthData', HealthSchema);

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
  // FIX: Subscribe đúng topic firmware v2.3 publish
  mqttClient.subscribe('gamefps/controller', { qos: 0 });
  mqttClient.subscribe('gamefps/command',    { qos: 1 });
  mqttClient.subscribe('gamefps/session',    { qos: 0 });
  mqttClient.subscribe('gamefps/health',     { qos: 0 });
});

mqttClient.on('error', err => console.error('[MQTT] Lỗi:', err.message));
mqttClient.on('reconnect', () => console.log('[MQTT] Đang kết nối lại...'));

// Giới hạn lưu DB 2 lần/giây
let lastSaved = 0;

mqttClient.on('message', async (topic, message) => {
  let data;
  try { data = JSON.parse(message.toString()); }
  catch { return; }

  if (topic === 'gamefps/controller') {
    const now = Date.now();
    if (now - lastSaved < 500) return; // rate limit
    lastSaved = now;
    try {
      await SensorData.create({
        pitch:   parseFloat(data.pitch)   || 0,
        roll:    parseFloat(data.roll)    || 0,
        yaw:     parseFloat(data.yaw)     || 0,
        buttons: parseInt(data.buttons)   || 0,
        mode:    parseInt(data.mode)      || 0,
      });
      console.log(`[DB] P:${(+data.pitch).toFixed(1)} R:${(+data.roll).toFixed(1)} Y:${(+data.yaw).toFixed(1)}`);
    } catch (e) { console.error('[DB]', e.message); }
  }

  if (topic === 'gamefps/session') {
    try { await Session.create(data); } catch (e) { console.error('[DB]', e.message); }
  }

  // Xử lý health topic
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
    } catch (e) { console.error('[DB health]', e.message); }
});

// ── API
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

// FIX: OTA command dùng đúng topic gamefps/command + payload START_OTA
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

app.listen(process.env.PORT || 3000, () =>
  console.log(`[API] Server port ${process.env.PORT || 3000}`));

// API ENDPOINT /API/HEALTH
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
