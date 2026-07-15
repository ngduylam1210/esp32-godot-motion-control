# ESP32 Game Motion Controller
An ESP32-based wireless motion controller system designed to simulate 3D camera movement in FPS games using 9-axis IMU sensor fusion.

#Project Overview
This project focuses on translating physical hand movements into low-latency game inputs. The system utilizes an MPU6050 and HMC5883L sensor array to track 3D space, processed via an RTOS architecture, and transmitted to the Godot Engine using a high-speed UDP protocol.

# Technical Features
Real-time Signal Processing: Implements a Complementary Filter combined with ZUPT (Zero Velocity Update) to eliminate sensor noise and prevent yaw drift.

Low-Latency Communication: UDP-based transmission direct to the Game Engine, optimized for high-speed flicks and instantaneous response.

# IoT & Monitoring:

Integrated MQTT telemetry for real-time reporting (temperature, RSSI, voltage).

Web Dashboard for remote system diagnostics.

FOTA (Firmware Over-the-Air): Supports remote firmware updates from GitHub via HTTPS.

# Tech Stack
Embedded: ESP32, C/C++, FreeRTOS, I2C.

Sensors: MPU6050 (Accel/Gyro), HMC5883L (Magnetometer).

Networking & IoT: UDP, MQTT (HiveMQ), WiFiManager.

Software: GDScript (Godot Engine), Node.js (Web Dashboard Server).

# Project Structure
├── firmware/          # ESP32 C++ source code
├── server/            # Node.js server & Web Dashboard
├── game_godot/       # Godot Engine project files
└── README.md          # Project documentation

# Data Flow Architecture
Sense: ESP32 retrieves raw sensor data via I2C protocol.

Process: FreeRTOS manages noise filtering and calculates orientation angles (Yaw, Pitch, Roll).

Transmit:

Control Data: Sent via UDP to the Godot game client.

Diagnostic Data: Pub/Sub via MQTT to the HiveMQ broker.

Action: Godot Engine updates the player's camera view in real-time.

# Monitoring Dashboard
The system features a web-based dashboard to monitor real-time system parameters (Uptime, Temperature, RSSI), ensuring device stability and simplifying the debugging process.

Developed as a capstone project for the IoT specialization at the University of Transport and Communications.
