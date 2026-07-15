#define FIRMWARE_VERSION "2.3"

#include <PubSubClient.h>
#include <Wire.h>
#include <WiFi.h>
#include <AsyncUDP.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <math.h>
#include <WiFiManager.h>
#include <esp_adc_cal.h>
#include <Preferences.h>

// ============================================================
// CẤU HÌNH HIVEMQ + OTA URL
// ============================================================
const char* mqtt_server = "";
const int   mqtt_port   = 8883;
const char* mqtt_user   = "";
const char* mqtt_pass   = "";

const char* OTA_BIN_URL = "";

WiFiClientSecure secureEspClient;
PubSubClient     mqttClient(secureEspClient);
Preferences      prefs;

volatile bool otaRequested = false;
String otaFirmwareUrl = "";

// ============================================================
// UDP & CONSTANTS
// ============================================================
const int godot_port = 4242;

#define MPU_ADDR 0x68
#define MAG_ADDR 0x1E

#define BTN_MODE  0x01
#define BTN_SHOOT 0x02

#define ALPHA          0.98f
#define MAG_YAW_WEIGHT 0.007f
#define ZUPT_THRESHOLD 0.3f
#define DEAD_ZONE      0.3f

#define PIN_SHOOT 14
#define PIN_MODE  13
#define PIN_LED   2

// ============================================================
// OFFSET CALIBRATION
// ============================================================
float offAX, offAY, offAZ;
float offGX, offGY, offGZ;
float offMX = 0.0f, offMY = 0.0f;
float scaleMX = 1.0f, scaleMY = 1.0f;

// ============================================================
// RTOS
// ============================================================
QueueHandle_t     dataQueue;
SemaphoreHandle_t i2cMutex;
TaskHandle_t      TaskOTA_Handle = NULL;
AsyncUDP          udp;

#pragma pack(push, 1)
struct ControllerData {
  uint8_t packetType = 0x01;
  uint8_t mode  = 0;
  float   roll;
  float   pitch;
  float   yaw;
  float   gx, gy, gz;
  uint8_t buttons;
};
#pragma pack(pop)

ControllerData globalLatestData;

// ============================================================
// THIẾT LẬP SENSOR
// ============================================================
void initMPU() {
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x6B); Wire.write(0x01); Wire.endTransmission();
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x1A); Wire.write(0x03); Wire.endTransmission();
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x1B); Wire.write(0x00); Wire.endTransmission();
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x1C); Wire.write(0x00); Wire.endTransmission();
}

void initMAG() {
  Wire.beginTransmission(MAG_ADDR); Wire.write(0x00); Wire.write(0x70); Wire.endTransmission();
  Wire.beginTransmission(MAG_ADDR); Wire.write(0x01); Wire.write(0xA0); Wire.endTransmission();
  Wire.beginTransmission(MAG_ADDR); Wire.write(0x02); Wire.write(0x00); Wire.endTransmission();
}

void ledBlink(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(PIN_LED, HIGH); delay(delayMs);
    digitalWrite(PIN_LED, LOW);  delay(delayMs);
  }
}

// ============================================================
// MPU CALIBRATION
// ============================================================
void calibrateMPU() {
  Serial.println("[CAL-MPU] Dat nam phang, dung yen...");
  unsigned long start = millis();
  while (millis() - start < 2000) {
    digitalWrite(PIN_LED, HIGH); delay(500);
    digitalWrite(PIN_LED, LOW);  delay(500);
  }

  Serial.println("[CAL-MPU] Dang lay mau...");
  long sAX=0,sAY=0,sAZ=0,sGX=0,sGY=0,sGZ=0;
  const int N = 500;
  for (int i = 0; i < N; i++) {
    Wire.beginTransmission(MPU_ADDR); Wire.write(0x3B); Wire.endTransmission(false);
    Wire.requestFrom(MPU_ADDR, 14, true);
    sAX += int16_t(Wire.read()<<8|Wire.read());
    sAY += int16_t(Wire.read()<<8|Wire.read());
    sAZ += int16_t(Wire.read()<<8|Wire.read());
    Wire.read(); Wire.read();
    sGX += int16_t(Wire.read()<<8|Wire.read());
    sGY += int16_t(Wire.read()<<8|Wire.read());
    sGZ += int16_t(Wire.read()<<8|Wire.read());
    if (i % 50 == 0) digitalWrite(PIN_LED, !digitalRead(PIN_LED));
    delay(2);
  }
  digitalWrite(PIN_LED, LOW);

  offAX = (sAX/(float)N)/16384.0f;
  offAY = (sAY/(float)N)/16384.0f;
  offAZ = ((sAZ/(float)N)/16384.0f) - 1.0f;
  offGX = (sGX/(float)N)/131.0f;
  offGY = (sGY/(float)N)/131.0f;
  offGZ = (sGZ/(float)N)/131.0f;

  Serial.printf("[CAL-MPU] Accel: %.3f %.3f %.3f | Gyro: %.3f %.3f %.3f\n",
                offAX,offAY,offAZ, offGX,offGY,offGZ);
  ledBlink(3, 150);
  digitalWrite(PIN_LED, HIGH); delay(2000);
  digitalWrite(PIN_LED, LOW);
}

// ============================================================
// MAG CALIBRATION
// ============================================================
void calibrateMAG(bool forceRecal = false) {
  prefs.begin("mag_cal", true);
  bool hasSaved = prefs.isKey("offMX");
  prefs.end();

  if (hasSaved && !forceRecal) {
    prefs.begin("mag_cal", true);
    offMX   = prefs.getFloat("offMX",   0.0f);
    offMY   = prefs.getFloat("offMY",   0.0f);
    scaleMX = prefs.getFloat("scaleMX", 1.0f);
    scaleMY = prefs.getFloat("scaleMY", 1.0f);
    prefs.end();
    Serial.printf("[CAL-MAG] NVS → offX:%.1f offY:%.1f scX:%.3f scY:%.3f\n",
                  offMX, offMY, scaleMX, scaleMY);
    return;
  }

  Serial.println("[CAL-MAG] Hieu chuan moi...");
  ledBlink(3, 200);
  Serial.println("[CAL-MAG] Xoay theo moi huong! Bat dau sau 3s...");
  delay(3000);

  const unsigned long CAL_DURATION_MS = 30000;
  const int CAL_INTERVAL_MS = 20;
  int16_t minX = 32767, maxX = -32768, minY = 32767, maxY = -32768;
  int validSamples = 0;
  unsigned long startMs = millis(), lastBlink = 0;
  bool ledState = false;

  while (millis() - startMs < CAL_DURATION_MS) {
    if (millis() - lastBlink >= 1000) {
      ledState = !ledState;
      digitalWrite(PIN_LED, ledState);
      lastBlink = millis();
    }
    Wire.beginTransmission(MAG_ADDR); Wire.write(0x09); Wire.endTransmission(false);
    Wire.requestFrom(MAG_ADDR, 1, true);
    if (Wire.available() && (Wire.read() & 0x01)) {
      Wire.beginTransmission(MAG_ADDR); Wire.write(0x03); Wire.endTransmission(false);
      Wire.requestFrom(MAG_ADDR, 6, true);
      if (Wire.available() >= 6) {
        int16_t rawX = Wire.read()<<8 | Wire.read();
        Wire.read(); Wire.read();
        int16_t rawY = Wire.read()<<8 | Wire.read();
        if (rawX != -4096 && rawY != -4096) {
          if (rawX < minX) minX = rawX; if (rawX > maxX) maxX = rawX;
          if (rawY < minY) minY = rawY; if (rawY > maxY) maxY = rawY;
          validSamples++;
        }
      }
    }
    delay(CAL_INTERVAL_MS);
  }
  digitalWrite(PIN_LED, LOW);

  int rangeX = maxX - minX, rangeY = maxY - minY;
  if (validSamples < 50 || rangeX < 50 || rangeY < 50) {
    Serial.println("[CAL-MAG] Canh bao: Du lieu kem → dung mac dinh");
    offMX = 0.0f; offMY = 0.0f; scaleMX = 1.0f; scaleMY = 1.0f;
  } else {
    offMX = (maxX + minX) / 2.0f; offMY = (maxY + minY) / 2.0f;
    float avgRange = (rangeX + rangeY) / 2.0f;
    scaleMX = avgRange / (float)rangeX; scaleMY = avgRange / (float)rangeY;
    Serial.printf("[CAL-MAG] OK! offX:%.1f offY:%.1f scX:%.3f scY:%.3f\n",
                  offMX, offMY, scaleMX, scaleMY);
    prefs.begin("mag_cal", false);
    prefs.putFloat("offMX", offMX); prefs.putFloat("offMY", offMY);
    prefs.putFloat("scaleMX", scaleMX); prefs.putFloat("scaleMY", scaleMY);
    prefs.end();
  }
  digitalWrite(PIN_LED, HIGH); delay(2000); digitalWrite(PIN_LED, LOW);
}

// ============================================================
// SENSOR READ
// ============================================================
bool readMPU(float &ax, float &ay, float &az, float &gx, float &gy, float &gz) {
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x3B); Wire.endTransmission(false);
  if (Wire.requestFrom(MPU_ADDR, 14, true) != 14) return false;
  ax = (int16_t(Wire.read()<<8|Wire.read())/16384.0f) - offAX;
  ay = (int16_t(Wire.read()<<8|Wire.read())/16384.0f) - offAY;
  az = (int16_t(Wire.read()<<8|Wire.read())/16384.0f) - offAZ;
  Wire.read(); Wire.read();
  gx = (int16_t(Wire.read()<<8|Wire.read())/131.0f) - offGX;
  gy = (int16_t(Wire.read()<<8|Wire.read())/131.0f) - offGY;
  gz = (int16_t(Wire.read()<<8|Wire.read())/131.0f) - offGZ;
  return true;
}

bool readMAG(float &mx, float &my) {
  Wire.beginTransmission(MAG_ADDR); Wire.write(0x09); Wire.endTransmission(false);
  Wire.requestFrom(MAG_ADDR, 1, true);
  if (!Wire.available() || !(Wire.read() & 0x01)) return false;
  Wire.beginTransmission(MAG_ADDR); Wire.write(0x03); Wire.endTransmission(false);
  Wire.requestFrom(MAG_ADDR, 6, true);
  if (Wire.available() < 6) return false;
  int16_t rawX = Wire.read()<<8|Wire.read();
  Wire.read(); Wire.read();
  int16_t rawY = Wire.read()<<8|Wire.read();
  if (rawX == -4096 || rawY == -4096) return false;
  mx = (rawX - offMX) * scaleMX; my = (rawY - offMY) * scaleMY;
  return true;
}

float readBatteryVoltage() { return 5.0f; }

// ============================================================
// CALLBACK MQTT
// ============================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  if (String(topic) == "gamefps/command" && msg.indexOf("START_OTA") >= 0) {
    otaFirmwareUrl = OTA_BIN_URL;
    otaRequested   = true;
    Serial.println("[MQTT] Da nhan lenh cap nhat OTA!");
  }
}

// ============================================================
// TASK OTA
// ============================================================
void Task_OTA(void *pvParameters) {
  for (;;) {
    if (otaRequested) {
      Serial.println("\n[OTA] ===== BAT DAU CAP NHAT =====");
      if (mqttClient.connected())
        mqttClient.publish("gamefps/ota_status",
          "{\"status\":\"downloading\",\"message\":\"Dang tai firmware...\"}", false);

      for (int i = 0; i < 10; i++) {
        digitalWrite(PIN_LED, !digitalRead(PIN_LED)); delay(100);
      }
      digitalWrite(PIN_LED, HIGH);

      WiFiClientSecure secureClient;
      secureClient.setInsecure();
      secureClient.setTimeout(30);
      HTTPClient http;
      http.begin(secureClient, otaFirmwareUrl);
      http.setTimeout(30000);
      http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

      int httpCode = http.GET();
      if (httpCode == 200) {
        int contentLength = http.getSize();
        if (contentLength > 0 && Update.begin(contentLength)) {
          Serial.println("[OTA] Dang ghi Flash...");
          if (mqttClient.connected())
            mqttClient.publish("gamefps/ota_status",
              "{\"status\":\"flashing\",\"message\":\"Dang ghi Flash...\"}", false);
          WiFiClient& stream = http.getStream();
          size_t written = Update.writeStream(stream);
          if (written == (size_t)contentLength && Update.end(true)) {
            Serial.println("[OTA] ===== THANH CONG! Restart... =====");
            if (mqttClient.connected())
              mqttClient.publish("gamefps/ota_status",
                "{\"status\":\"success\",\"message\":\"Cap nhat thanh cong!\"}", true);
            delay(2000);
            ESP.restart();
          } else {
            if (mqttClient.connected())
              mqttClient.publish("gamefps/ota_status",
                "{\"status\":\"error\",\"message\":\"Loi ghi Flash\"}", false);
          }
        }
      } else {
        if (mqttClient.connected()) {
          String errMsg = "{\"status\":\"error\",\"message\":\"HTTP " + String(httpCode) + "\"}";
          mqttClient.publish("gamefps/ota_status", errMsg.c_str(), false);
        }
      }
      http.end();
      otaFirmwareUrl = "";
      otaRequested   = false;
      digitalWrite(PIN_LED, LOW);
    }
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

// ============================================================
// TASK UDP STREAM
// ============================================================
void Task_UDP_Stream(void *pvParameters) {
  if (WiFi.status() == WL_CONNECTED) {
    udp.close();  
  }

  ControllerData buffer;
  for (;;) {
    if (!otaRequested) {
      if (xQueueReceive(dataQueue, &buffer, pdMS_TO_TICKS(5))) {
        globalLatestData = buffer;
        if (WiFi.status() == WL_CONNECTED) {
          uint8_t buf[27];
          buf[0] = buffer.packetType; buf[1] = buffer.mode;
          memcpy(&buf[2],  &buffer.roll,  4);
          memcpy(&buf[6],  &buffer.pitch, 4);
          memcpy(&buf[10], &buffer.yaw,   4);
          memcpy(&buf[14], &buffer.gx,    4);
          memcpy(&buf[18], &buffer.gy,    4);
          memcpy(&buf[22], &buffer.gz,    4);
          buf[26] = buffer.buttons;
          Serial.println("UDP SENT");
          IPAddress pcIP(192,168,1,115);
          udp.writeTo(buf,sizeof(buf),pcIP,4242);
        }
      }
    } else {
      ControllerData dummy;
      xQueueReceive(dataQueue, &dummy, 0);
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

// ============================================================
// TASK MQTT & WIFI
// ============================================================
void Task_MQTT_Web(void *pvParameters) {
  if (WiFi.status() == WL_CONNECTED) {
    secureEspClient.setInsecure();
    mqttClient.setKeepAlive(60);
    mqttClient.setSocketTimeout(5);
    mqttClient.setServer(mqtt_server, mqtt_port);
    mqttClient.setCallback(mqttCallback);
  }

  unsigned long lastMqttSend      = 0;
  unsigned long lastMqttReconnect = 0;

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WIFI] Mat ket noi! Dang thu ket noi lai...");
      WiFi.reconnect();
      vTaskDelay(pdMS_TO_TICKS(3000));
      continue;
    }

    if (!otaRequested) {
      if (mqttClient.connected()) {
        mqttClient.loop();
        if (millis() - lastMqttSend >= 500) {
          char payload[200];
          snprintf(payload, sizeof(payload),
            "{\"pitch\":%.2f,\"roll\":%.2f,\"yaw\":%.2f,"
            "\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f,\"buttons\":%d}",
            globalLatestData.pitch, globalLatestData.roll, globalLatestData.yaw,
            globalLatestData.gx,    globalLatestData.gy,   globalLatestData.gz,
            globalLatestData.buttons);
          mqttClient.publish("gamefps/controller", payload);
          lastMqttSend = millis();
        }
      } else {
        if (millis() - lastMqttReconnect > 5000) {
          lastMqttReconnect = millis();
          Serial.println("[MQTT] Ket noi voi HiveMQ...");
          if (mqttClient.connect("ESP32_GameFPS", mqtt_user, mqtt_pass)) {
            Serial.println("[MQTT] Ket noi thanh cong!");
            mqttClient.subscribe("gamefps/command");
          }
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// ============================================================
// TASK HEALTH
// ============================================================
void Task_Health(void *pv) {
  vTaskDelay(pdMS_TO_TICKS(5000));
  for (;;) {
    if (WiFi.status() == WL_CONNECTED && mqttClient.connected()) {
      float volt   = readBatteryVoltage();
      float temp   = temperatureRead();
      int   rssi   = WiFi.RSSI();
      long  uptime = millis() / 1000;
      char  payload[200];
      snprintf(payload, sizeof(payload),
        "{\"uptime\":%ld,\"voltage\":%.2f,\"temperature\":%.1f,"
        "\"rssi\":%d,\"version\":\"%s\",\"mqttConnected\":true}",
        uptime, volt, temp, rssi, FIRMWARE_VERSION);
      mqttClient.publish("gamefps/health", payload, false);
    }
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

// ============================================================
// TASK SENSOR
// ============================================================
void Task_Sensor(void *pvParameters) {
  float pitch=0, roll=0, yaw=0;
  unsigned long prevTime = micros();
  ControllerData sendData;
  TickType_t lastWake = xTaskGetTickCount();
  uint8_t currentMode = 1;
  bool lastModeBtnState = true;

  for (;;) {
    unsigned long now = micros();
    float dt = (now - prevTime) / 1000000.0f;
    prevTime = now;

    if (dt > 0 && dt <= 0.05f) {
      float ax,ay,az,gx,gy,gz;
      xSemaphoreTake(i2cMutex, portMAX_DELAY);
      bool mpuOK = readMPU(ax,ay,az,gx,gy,gz);
      float mx,my; bool magOK = readMAG(mx,my);
      xSemaphoreGive(i2cMutex);

      if (mpuOK) {
        bool zupt = (sqrt(gx*gx+gy*gy+gz*gz) < ZUPT_THRESHOLD);
        float accPitch = atan2(-ax, sqrt(ay*ay+az*az)) * 180.0f/PI;
        float accRoll  = atan2(ay, az) * 180.0f/PI;

        if (zupt) {
          pitch = 0.80f*pitch + 0.20f*accPitch;
          roll  = 0.80f*roll  + 0.20f*accRoll;
        } else {
          pitch = ALPHA*(pitch+gy*dt) + (1-ALPHA)*accPitch;
          roll  = ALPHA*(roll +gx*dt) + (1-ALPHA)*accRoll;
          yaw  += gz*dt;
        }
        if (yaw >  180.0f) yaw -= 360.0f;
        if (yaw < -180.0f) yaw += 360.0f;

        bool shootBtn = (digitalRead(PIN_SHOOT) == LOW);
        bool currentModeBtnState_ = digitalRead(PIN_MODE);
        if (lastModeBtnState == HIGH && currentModeBtnState_ == LOW) {
          currentMode = (currentMode == 1) ? 2 : 1;
          digitalWrite(PIN_LED, currentMode == 1 ? LOW : HIGH);
        }
        lastModeBtnState = currentModeBtnState_;

        sendData.pitch = pitch; sendData.roll  = roll;
        sendData.yaw   = yaw;   sendData.mode  = currentMode;
        sendData.gx    = gx;    sendData.gy    = gy; sendData.gz = gz;

        uint8_t btns = 0;
        if (currentModeBtnState_ == LOW) btns |= BTN_MODE;
        if (shootBtn)                    btns |= BTN_SHOOT;
        sendData.buttons = btns;
        xQueueOverwrite(dataQueue, &sendData);
      }
    }
    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(20));
  }
}

// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  Wire.setClock(400000);

  pinMode(PIN_SHOOT, INPUT_PULLUP);
  pinMode(PIN_MODE,  INPUT_PULLUP);
  pinMode(PIN_LED,   OUTPUT);
  digitalWrite(PIN_LED, LOW);

  initMPU();
  initMAG();
  calibrateMPU();

  bool forceRecal = (digitalRead(PIN_MODE) == LOW);
  if (forceRecal) Serial.println("[BOOT] Giu MODE → EP HIEU CHUAN MAG!");
  calibrateMAG(forceRecal);

  i2cMutex = xSemaphoreCreateMutex();
  dataQueue = xQueueCreate(1, sizeof(ControllerData));

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect("GameFPS")) {
    Serial.println("[WiFi] THAT BAI. Restart!");
    delay(3000); ESP.restart();
  }
  Serial.printf("[WiFi] OK — IP: %s\n", WiFi.localIP().toString().c_str());
  WiFi.setSleep(false);

  xTaskCreatePinnedToCore(Task_Sensor,     "Sensor",     4096, NULL, 2, NULL,              1);
  xTaskCreatePinnedToCore(Task_UDP_Stream, "UDP_Stream", 4096, NULL, 2, NULL,              0);
  xTaskCreatePinnedToCore(Task_MQTT_Web,   "MQTT_Web",   8192, NULL, 1, NULL,              0);
  xTaskCreatePinnedToCore(Task_OTA,        "OTA",        8192, NULL, 1, &TaskOTA_Handle,   0);
  xTaskCreatePinnedToCore(Task_Health,     "Health",     4096, NULL, 1, NULL,              0);

  Serial.printf("\n=== FIRMWARE v%s DA KHOI DONG ===\n", FIRMWARE_VERSION);
}

void loop() {
  vTaskDelete(NULL);
}
