#define DEBUG 0  // Set to 1 to enable Serial, 0 to disable entirely

#if DEBUG
  #define DEBUG_PRINT(x)       Serial.print(x)
  #define DEBUG_PRINTLN(x)     Serial.println(x)
  #define DEBUG_BEGIN(x)       Serial.begin(x)
#else
  #define DEBUG_PRINT(x)
  #define DEBUG_PRINTLN(x)
  #define DEBUG_BEGIN(x)
#endif

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
#define sittingRoomLightRelayPin 14
#define bedRoomLightRelayPin 13
#define sittingRoomSocketRelayPin 27
#define bedRoomSocketRelayPin 12

/************ LOAD FEEDBACK (INPUT ONLY PINS) ************/
#define sittingRoomLightFeedbackPin 32
#define bedRoomLightFeedbackPin 33

/************ SERVOS ************/
#define sittingRoomWindowServoPin 2
#define bedRoomWindowServoPin 15

Servo sittingRoomWindowServo;
Servo bedRoomWindowServo;

#define LOAD_SITTING 0
#define LOAD_BEDROOM 1

/************ COMMAND ACKS ************/
// store last processed cmdId per device so identical re-writes can be processed once
String lastCmdId_sitting = "";
String lastCmdId_bed = "";
void updateLoadFeedback(uint8_t index, bool forceWrite = false);
/***************************************************/
void setup() {

  DEBUG_BEGIN(115200);

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
    DEBUG_PRINT(".");
  }
  DEBUG_PRINTLN("\nWiFi connected");

  // ---------- FIREBASE ----------
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  DEBUG_PRINT("Signing in");
  while (auth.token.uid == "") {
    DEBUG_PRINT(".");
    delay(300);
  }
  DEBUG_PRINTLN("\nFirebase authenticated");

  // ---------- SERVOS ----------
  sittingRoomWindowServo.attach(sittingRoomWindowServoPin);
  bedRoomWindowServo.attach(bedRoomWindowServoPin);

  // ---------- SAFE STARTUP SYNC ----------
  relayStartupSync();  // observe loads

  // ---------- START LISTENER ----------
  Firebase.RTDB.beginStream(&stream, "/control");
  Firebase.RTDB.setStreamCallback(&stream, streamCallback, streamTimeout);

  systemReady = true;
  DEBUG_PRINTLN("System READY");
}

/***************************************************/
void loop() {
  if (WiFi.isConnected()){
    // heartbeat every 2 seconds
    if (millis() - lastHeartbeat > 2000) {
      lastHeartbeat = millis();
      if (!Firebase.RTDB.setInt(&fbdo, "/heartbeat", lastHeartbeat)) {
        DEBUG_PRINTLN("Heartbeat write failed");
        DEBUG_PRINTLN(fbdo.errorReason());
      } else {
        DEBUG_PRINTLN("Heartbeat sent");
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
 *
 * New behavior: control nodes now have two children:
 *   /control/<deviceKey>/value   (int)
 *   /control/<deviceKey>/cmdId   (string)
 *
 * The stream will trigger when either child changes; we read both children,
 * and if cmdId differs from last processed cmdId for the device, we process
 * the command (apply relay/servo) and then write an ack at:
 *   /feedbackMeta/<deviceKey>/lastCmdId = <cmdId>
 *
 * The scalar feedback remains at:
 *   /feedback/<deviceKey> (unchanged behavior for UI compatibility)
 ***************************************************/
void streamCallback(FirebaseStream data) {

  DEBUG_PRINTLN("🔥 CALLBACK FIRED");

  if (!systemReady) return;

  String path = data.dataPath(); // e.g. "/sittingRoomLight/cmdId" or "/sittingRoomLight/value"
  DEBUG_PRINT("Stream Path: ");
  DEBUG_PRINTLN(path);

  // We will handle every event under /control children. Identify device.
  if (path.startsWith("/sittingRoomLight")) {
    handleControlForDevice("sittingRoomLight", 1);
  } else if (path.startsWith("/bedRoomLight")) {
    handleControlForDevice("bedRoomLight", 2);
  } else if (path.startsWith("/sittingRoomSocket")) {
    handleControlForDevice("sittingRoomSocket", 3);
  } else if (path.startsWith("/bedRoomSocket")) {
    handleControlForDevice("bedRoomSocket", 4);
  } else if (path.startsWith("/sittingRoomWindow")) {
    handleControlForServo("sittingRoomWindow", 1);
  } else if (path.startsWith("/bedRoomWindow")) {
    handleControlForServo("bedRoomWindow", 2);
  }
}

void streamTimeout(bool timeout) {
  if (timeout) DEBUG_PRINTLN("Firebase stream timeout");
}

/***************************************************
 * HELPERS: read control children and process commands
 ***************************************************/
bool readControlValueInt(const String &deviceKey, int &outValue) {
  String valuePath = "/control/" + deviceKey + "/value";
  if (!Firebase.RTDB.getInt(&fbdo, valuePath)) {
    DEBUG_PRINT("getInt failed for ");
    DEBUG_PRINTLN(valuePath);
    DEBUG_PRINTLN(fbdo.errorReason());
    return false;
  }
  outValue = fbdo.intData();
  return true;
}

bool readControlCmdId(const String &deviceKey, String &outCmdId) {
  String cmdPath = "/control/" + deviceKey + "/cmdId";
  if (!Firebase.RTDB.getString(&fbdo, cmdPath)) {
    // It's okay if it doesn't exist yet, return empty string
    outCmdId = "";
    // Not treating as fatal
    return false;
  }
  outCmdId = fbdo.stringData();
  return true;
}

void writeAckLastCmdId(const String &deviceKey, const String &cmdId) {
  String ackPath = "/feedbackMeta/" + deviceKey + "/lastCmdId";
  if (!Firebase.RTDB.setString(&fbdo, ackPath, cmdId)) {
    DEBUG_PRINT("Failed to write ack ");
    DEBUG_PRINTLN(ackPath);
    DEBUG_PRINTLN(fbdo.errorReason());
  } else {
    DEBUG_PRINT("Wrote ack ");
    DEBUG_PRINT(ackPath);
    DEBUG_PRINT(" = ");
    DEBUG_PRINTLN(cmdId);
  }
}

/***************************************************
 * RELAY CONTROL (ONLINE COMMAND)
 *
 * Note: This now expects we call this when a new cmdId is detected.
 ***************************************************/
/***void handleRelay(uint8_t index, int value) {

  uint8_t pin;
  int loadIndex=-1;

  switch (index) {
    case 1: pin = sittingRoomLightRelayPin; loadIndex = LOAD_SITTING; digitalWrite(pin, value ? HIGH : LOW); break;
    case 2: pin = bedRoomLightRelayPin; loadIndex = LOAD_BEDROOM; digitalWrite(pin, value ? HIGH : LOW); break;
    case 3: pin = sittingRoomSocketRelayPin; digitalWrite(pin, value ? LOW : HIGH); break;
    case 4: pin = bedRoomSocketRelayPin; digitalWrite(pin, value ? LOW : HIGH); break;
    default: return;
  }

  // FORCE feedback sync (write the scalar feedback - unchanged behavior)
  if (loadIndex != -1) {
    // Pass true to write whatever the current load reads even if unchanged
    updateLoadFeedback(loadIndex, true);
  }
}***/
void handleRelay(uint8_t index, int value) {
  uint8_t relayPin;
  int loadIndex = -1;

  // Map the index to the correct relay and feedback load
  switch (index) {
    case 1: relayPin = sittingRoomLightRelayPin; loadIndex = LOAD_SITTING; break;
    case 2: relayPin = bedRoomLightRelayPin;    loadIndex = LOAD_BEDROOM; break;
    case 3: digitalWrite(sittingRoomSocketRelayPin, value ? LOW : HIGH); return; // Sockets usually don't have 2-way feedback
    case 4: digitalWrite(bedRoomSocketRelayPin, value ? LOW : HIGH); return;
    default: return;
  }

  // --- THE 2-WAY FIX ---
  // 1. Check what the light is ACTUALLY doing right now via the feedback pin
  int currentActualState = readLoad(loadIndex); 

  // 2. Compare actual state to what the user requested from the app
  // If the app wants it ON (1) but it's OFF (0), or vice versa...
  if (value != currentActualState) {
    DEBUG_PRINTLN("State mismatch detected. Toggling relay to sync...");
    
    // 3. Flip the relay state (if it was HIGH, make it LOW; if LOW, make it HIGH)
    bool currentRelayPos = digitalRead(relayPin);
    digitalWrite(relayPin, !currentRelayPos);
  }

  // 4. Immediately update Firebase so the UI reflects the real-world state
  updateLoadFeedback(loadIndex, true);
}
/***************************************************
 * Read and process control children for relays
 ***************************************************/
void handleControlForDevice(const String &deviceKey, uint8_t index) {
  // Read both value and cmdId
  int value = 0;
  readControlValueInt(deviceKey, value); // if fails, value defaults to 0
  String cmdId;
  readControlCmdId(deviceKey, cmdId); // may return false and leave cmdId empty

  // Select the last processed cmdId pointer
  String *lastPtr = nullptr;
  if (index == 1) lastPtr = &lastCmdId_sitting;
  else if (index == 2) lastPtr = &lastCmdId_bed;
  // sockets (3,4) currently not tracked with cmdId in firmware (they are "assumed" devices), but we still can process

  // If no cmdId was provided, we treat this as a simple value write (legacy behavior)
  if (cmdId == "") {
    // legacy/compatibility: if plain integer under /control/<device> (older clients), just apply value
    // special-case: check "/control/<device>" integer root
    // Attempt to read root value if present
    String rootPath = "/control/" + deviceKey;
    if (Firebase.RTDB.getInt(&fbdo, rootPath)) {
      int rootVal = fbdo.intData();
      DEBUG_PRINT("Legacy root value for ");
      DEBUG_PRINT(deviceKey);
      DEBUG_PRINT(" = ");
      DEBUG_PRINTLN(rootVal);
      handleRelay(index, rootVal);
    } else {
      // apply the value read from /control/<device>/value if any
      handleRelay(index, value);
    }
    return;
  }

  // If we have a cmdId, process only when it differs from last processed
  String last = (lastPtr != nullptr) ? *lastPtr : String("");
  if (cmdId != last) {
    DEBUG_PRINT("New cmdId for ");
    DEBUG_PRINT(deviceKey);
    DEBUG_PRINT(": ");
    DEBUG_PRINTLN(cmdId);
    // Apply command (relay)
    handleRelay(index, value);

    // Update last processed cmdId and write ack meta
    if (lastPtr != nullptr) {
      *lastPtr = cmdId;
    }
    writeAckLastCmdId(deviceKey, cmdId);
  } else {
    DEBUG_PRINT("Duplicate cmdId (ignored): ");
    DEBUG_PRINTLN(cmdId);
  }
}

/***************************************************
 * READ LOAD STATE (TRUTH SOURCE)
 *
 * Note: readLoad returns 1 when the load is ON (same semantic as before).
 ***************************************************/
int readLoad(uint8_t index) {
  if (index == LOAD_SITTING)
    return digitalRead(sittingRoomLightFeedbackPin) == HIGH ? 1 : 0;

  if (index == LOAD_BEDROOM)
    return digitalRead(bedRoomLightFeedbackPin) == HIGH ? 1 : 0;

  return 0;
}

/***************************************************
 * LOAD FEEDBACK SYNC
 *
 * Modified to accept a 'forceWrite' parameter so we can
 * acknowledge commands even when the feedback value hasn't changed.
 ***************************************************/
void updateLoadFeedback(uint8_t index, bool forceWrite) {
  static int lastState[2] = { -1, -1 };

  int current = readLoad(index);

  if (current == lastState[index] && !forceWrite) return;
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
    DEBUG_PRINT("Feedback write failed: ");
    DEBUG_PRINTLN(fbdo.errorReason());
  } else {
    DEBUG_PRINT("Feedback OK index ");
    DEBUG_PRINT(index);
    DEBUG_PRINT(" = ");
    DEBUG_PRINTLN(current);
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
 *
 * We treat servos similarly: check cmdId under /control/<device>/cmdId
 * and process when it differs from last processed id.
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

/***************************************************
 * Convenience wrapper: when control change is for a servo,
 * read control children and process using cmdId semantics
 ***************************************************/
void handleControlForServo(const String &deviceKey, uint8_t index) {
  int value = 0;
  readControlValueInt(deviceKey, value);
  String cmdId;
  readControlCmdId(deviceKey, cmdId);

  // If no cmdId, attempt legacy root value
  if (cmdId == "") {
    String rootPath = "/control/" + deviceKey;
    if (Firebase.RTDB.getInt(&fbdo, rootPath)) {
      int rootVal = fbdo.intData();
      DEBUG_PRINT("Legacy servo root value for ");
      DEBUG_PRINT(deviceKey);
      DEBUG_PRINT(" = ");
      DEBUG_PRINTLN(rootVal);
      handleServo(index, rootVal);
    } else {
      handleServo(index, value);
    }
    return;
  }

  // For servos we track lastCmdId per-device by reusing sitting/bed globals
  String *lastPtr = nullptr;
  if (index == 1) lastPtr = &lastCmdId_sitting;
  else if (index == 2) lastPtr = &lastCmdId_bed;

  String last = (lastPtr != nullptr) ? *lastPtr : String("");
  if (cmdId != last) {
    DEBUG_PRINT("New servo cmdId for ");
    DEBUG_PRINT(deviceKey);
    DEBUG_PRINT(": ");
    DEBUG_PRINTLN(cmdId);
    handleServo(index, value);
    if (lastPtr != nullptr) *lastPtr = cmdId;
    // Write an ack in feedbackMeta for servo too
    writeAckLastCmdId(deviceKey, cmdId);
  } else {
    DEBUG_PRINT("Duplicate servo cmdId (ignored): ");
    DEBUG_PRINTLN(cmdId);
  }
}
