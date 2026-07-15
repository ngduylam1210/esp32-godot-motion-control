#include <Wire.h>

const int MPU = 0x68;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);

  Wire.beginTransmission(MPU); 
  Wire.write(0x6B); 
  Wire.write(0); 
  Wire.endTransmission();

  delay(1000);
  Serial.println("Sẵn sàng đọc dữ liệu");
}

void loop() {
  Wire.beginTransmission(MPU);
  Wire.write(0x3B); 
  Wire.endTransmission(false); 
  Wire.requestFrom(MPU, 14, true); 

  int16_t ax_raw = (Wire.read() << 8 | Wire.read());
  int16_t ay_raw = (Wire.read() << 8 | Wire.read());
  int16_t az_raw = (Wire.read() << 8 | Wire.read());

  Wire.read(); Wire.read(); 

  int16_t gx_raw = (Wire.read() << 8 | Wire.read());
  int16_t gy_raw = (Wire.read() << 8 | Wire.read());
  int16_t gz_raw = (Wire.read() << 8 | Wire.read());

  float ax = ax_raw / 16384.0;
  float ay = ay_raw / 16384.0;
  float az = az_raw / 16384.0;

  float gx = gx_raw / 131.0;
  float gy = gy_raw / 131.0;
  float gz = gz_raw / 131.0;
  
  Serial.print("Accel: "); Serial.print(ax); Serial.print("  |");
  Serial.print(ay); Serial.print("  |");
  Serial.println(az); 

  Serial.print("Gyro: "); Serial.print(gx); Serial.print("  |");
  Serial.print(gy); Serial.print("  |");
  Serial.println(gz); 
  delay(20);
}
