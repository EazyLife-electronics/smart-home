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
#define sittingRoomWindowServoPin 27
#define bedRoomWindowServoPin 26

Servo sittingRoomWindowServo;
Servo bedRoomWindowServo;

#define LOAD_SITTING 0
#define LOAD_BEDROOM 1

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

  // ---------- START LISTENER ----------
  Firebase.RTDB.beginStream(&stream, "/control");
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
    // Monitor physical switch changes
    updateLoadFeedback(LOAD_SITTING);
    updateLoadFeedback(LOAD_BEDROOM);


    delay(50);
    Firebase.RTDB.readStream(&stream);
  }
}

/***************************************************
 * FIREBASE LISTENER
 ***************************************************/
void streamCallback(FirebaseStream data) {

  Serial.println("🔥 CALLBACK FIRED");

  if (!systemReady) return;

  if (data.dataTypeEnum() != fb_esp_rtdb_data_type_integer &&
      data.dataTypeEnum() != fb_esp_rtdb_data_type_boolean) return;

  String path = data.dataPath();
  int value = data.intData();

  Serial.print("Path: ");
  Serial.print(path);
  Serial.print("  Value: ");
  Serial.println(value);

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
  int loadIndex=-1;

  switch (index) {
    case 1: pin = sittingRoomLightRelayPin; loadIndex = LOAD_SITTING; break;
    case 2: pin = bedRoomLightRelayPin; loadIndex = LOAD_BEDROOM; break;
    case 3: pin = sittingRoomSocketRelayPin; break;
    case 4: pin = bedRoomSocketRelayPin; break;
    default: return;
  }

  digitalWrite(pin, value ? HIGH : LOW);

  // FORCE feedback sync
  if (loadIndex != -1) {
    updateLoadFeedback(loadIndex);
  }
}


/***************************************************
 * READ LOAD STATE (TRUTH SOURCE)
 ***************************************************/

int readLoad(uint8_t index) {
  if (index == LOAD_SITTING)
    return digitalRead(sittingRoomLightFeedbackPin) == HIGH ? 0 : 1;

  if (index == LOAD_BEDROOM)
    return digitalRead(bedRoomLightFeedbackPin) == HIGH ? 0 : 1;

  return 0;
}

/***************************************************
 * LOAD FEEDBACK SYNC
 ***************************************************/
void updateLoadFeedback(uint8_t index) {
  static int lastState[2] = { -1, -1 };

  int current = readLoad(index);

  if (current == lastState[index]) return;
  lastState[index] = current;

  bool ok = false;

  if (index == LOAD_SITTING) {
    ok = Firebase.RTDB.setInt(
      &fbdo,
      "/feedback/sittingRoomLightFeedback",
      current
    );
  }
  else if (index == LOAD_BEDROOM) {
    ok = Firebase.RTDB.setInt(
      &fbdo,
      "/feedback/bedRoomLightFeedback",
      current
    );
  }

  if (!ok) {
    Serial.print("Feedback write failed: ");
    Serial.println(fbdo.errorReason());
  } else {
    Serial.print("Feedback OK index ");
    Serial.print(index);
    Serial.print(" = ");
    Serial.println(current);
  }
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

  Firebase.RTDB.setInt(&fbdo, "/feedback/sittingRoomLightFeedback", readLoad(LOAD_SITTING));
  Firebase.RTDB.setInt(&fbdo, "/feedback/bedRoomLightFeedback", readLoad(LOAD_BEDROOM));
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
