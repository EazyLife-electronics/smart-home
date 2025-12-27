#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <ESP32Servo.h>

/************ WIFI ************/
#define WIFI_SSID "Manager"
#define WIFI_PASSWORD "managger"

/************ FIREBASE ************/
#define API_KEY "AIzaSyDFfzHIoNCHOKcXR0WoOQZQPHFUM3_pznY"
#define DATABASE_URL "https://smart-homes-buliamix-default-rtdb.firebaseio.com"
#define USER_EMAIL "damzyeazy@gmail.com"
#define USER_PASSWORD "iotdeveloper"

/************ FIREBASE OBJECTS ************/
FirebaseData fbdo;
FirebaseData stream;
FirebaseAuth auth;
FirebaseConfig config;

/************ SYSTEM STATE ************/
bool systemReady = false;
unsigned long lastHeartbeat = 0;

/************ RELAYS ************/
#define sittingRoomLightRelayPin 21
#define bedRoomLightRelayPin 33
#define sittingRoomSocketRelayPin 19
#define bedRoomSocketRelayPin 25

/************ LOAD FEEDBACK (INPUT ONLY PINS) ************/
#define sittingRoomLightFeedbackPin 22
#define bedRoomLightFeedbackPin 32

/************ SERVOS ************/
#define sittingRoomWindowServoPin 18
#define bedRoomWindowServoPin 26

Servo sittingRoomWindowServo;
Servo bedRoomWindowServo;


/***************************************************/
void setup() {

  Serial.begin(115200);

  pinMode(sittingRoomLightRelayPin, OUTPUT);
  pinMode(bedRoomLightRelayPin, OUTPUT);
  pinMode(sittingRoomSocketRelayPin, OUTPUT);
  pinMode(bedRoomSocketRelayPin, OUTPUT);

  pinMode(sittingRoomLightFeedbackPin, INPUT);
  pinMode(bedRoomLightFeedbackPin, INPUT);

  // ---------- WIFI ----------
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");

  // ---------- FIREBASE ----------
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  Serial.print("Signing in");
  while (auth.token.uid == "") {
    Serial.print(".");
    delay(300);
  }
  Serial.println("\nFirebase authenticated");

  // ---------- SERVOS ----------
  sittingRoomWindowServo.attach(sittingRoomWindowServoPin);
  bedRoomWindowServo.attach(bedRoomWindowServoPin);

  // ---------- SAFE STARTUP SYNC ----------
  relayStartupSync();  // observe loads
  servoStartupSync();  // report servo position

  // ---------- START LISTENER ----------
  Firebase.RTDB.beginStream(&stream, "/controls");
  Firebase.RTDB.setStreamCallback(&stream, streamCallback, streamTimeout);

  systemReady = true;
  Serial.println("System READY");
}

/***************************************************/
void loop() {
  if (WiFi.isConnected()){
    // heartbeat every 2 seconds
    if (millis() - lastHeartbeat > 2000) {
      lastHeartbeat = millis();
      if (!Firebase.RTDB.setInt(&fbdo, "/heartbeat", lastHeartbeat)) {
        Serial.println("Heartbeat write failed");
        Serial.println(fbdo.errorReason());
      } else {
        Serial.println("Heartbeat sent");
      }
    }
  }
  // Monitor physical switch changes
  updateLoadFeedback(1);
  updateLoadFeedback(2);
  updateServoFeedback(1);
  updateServoFeedback(2);

  delay(200);
}

/***************************************************
 * FIREBASE LISTENER
 ***************************************************/
void streamCallback(FirebaseStream data) {

  if (!systemReady) return;

  if (data.dataType() != "int") return;

  String path = data.dataPath();
  int value = data.intData();

  if (path == "/sittingRoomLight") handleRelay(1, value);
  else if (path == "/bedRoomLight") handleRelay(2, value);
  else if (path == "/sittingRoomSocket") handleRelay(3, value);
  else if (path == "/bedRoomSocket") handleRelay(4, value);
  else if (path == "/sittingRoomWindow") handleServo(1, value);
  else if (path == "/bedRoomWindow") handleServo(2, value);
}

void streamTimeout(bool timeout) {
  if (timeout) Serial.println("Firebase stream timeout");
}

/***************************************************
 * RELAY CONTROL (ONLINE COMMAND)
 ***************************************************/
void handleRelay(uint8_t index, int value) {

  uint8_t pin;
  switch (index) {
    case 1: pin = sittingRoomLightRelayPin; break;
    case 2: pin = bedRoomLightRelayPin; break;
    case 3: pin = sittingRoomSocketRelayPin; break;
    case 4: pin = bedRoomSocketRelayPin; break;
    default: return;
  }

  digitalWrite(pin, value ? HIGH : LOW);
}

/***************************************************
 * READ LOAD STATE (TRUTH SOURCE)
 ***************************************************/
int readLoad(uint8_t index) {
  if (index == 1) return digitalRead(sittingRoomLightFeedbackPin);
  if (index == 2) return digitalRead(bedRoomLightFeedbackPin);
  return 0;
}

/***************************************************
 * READ LOAD STATE (TRUTH SOURCE)
 ***************************************************/
int readServo(uint8_t index) {
  if (index == 1) return sittingRoomWindowServo.read();
  if (index == 2) return bedRoomWindowServo.read();
  return 0;
}

/***************************************************
 * LOAD FEEDBACK SYNC
 ***************************************************/
void updateLoadFeedback(uint8_t index) {
  static int lastState[3] = { -1, -1, -1 };

  int current = readLoad(index);
  if (current == lastState[index]) return;
  lastState[index] = current;

  if (index == 1)
    Firebase.RTDB.setInt(&fbdo, "/feedback/sittingRoomLightFeedback", current);
  else if (index == 2)
    Firebase.RTDB.setInt(&fbdo, "/feedback/bedRoomLightFeedback", current);
}

/***************************************************
 * LOAD FEEDBACK SYNC
 ***************************************************/
void updateServoFeedback(uint8_t index) {
  static int lastState[3] = { -1, -1, -1 };

  int current = map(readServo(index), 0, 180, 0, 100);
  if (current == lastState[index]) return;
  lastState[index] = current;

  if (index == 1)
    Firebase.RTDB.setInt(&fbdo, "/feedback/sittingRoomWindow", current);
  else if (index == 2)
    Firebase.RTDB.setInt(&fbdo, "/feedback/bedRoomWindow", current);
}


/***************************************************
 * SAFE RELAY STARTUP
 ***************************************************/
void relayStartupSync() {

  digitalWrite(sittingRoomLightRelayPin, LOW);
  digitalWrite(bedRoomLightRelayPin, LOW);
  digitalWrite(sittingRoomSocketRelayPin, LOW);
  digitalWrite(bedRoomSocketRelayPin, LOW);

  delay(200);

  Firebase.RTDB.setInt(&fbdo, "/feedback/sittingRoomLightFeedback", readLoad(1));
  Firebase.RTDB.setInt(&fbdo, "/feedback/bedRoomLightFeedback", readLoad(2));
}

/***************************************************
 * SERVO STARTUP SYNC (NO MOVEMENT)
 ***************************************************/
void servoStartupSync() {

  Firebase.RTDB.setInt(&fbdo, "/feedback/sittingRoomWindow", map(sittingRoomWindowServo.read(), 0, 180, 0, 100));
  Firebase.RTDB.setInt(&fbdo, "/feedback/bedRoomWindow", map(bedRoomWindowServo.read(), 0, 180, 0, 100));
}

/***************************************************
 * SERVO COMMAND HANDLER
 ***************************************************/
void handleServo(uint8_t index, int percent) {
  static int lastPercent[3] = { -1, -1, -1 };

  percent = constrain(percent, 0, 100);
  if (lastPercent[index] == percent) return;
  lastPercent[index] = percent;

  int angle = map(percent, 0, 100, 0, 180);

  if (index == 1) {
    sittingRoomWindowServo.write(angle);
  } else if (index == 2) {
    bedRoomWindowServo.write(angle);
  }
}
