// otio-device-running.swift
//
// Reads whether any process is running the macOS default output device.
// Read-only: no audio is written, no device property is set, and no device stream is opened,
// so the reading cannot start the device it measures.
//
// On success it prints one JSON line to stdout and exits 0:
//   {"deviceId":<n>,"name":"<device name>","running":<true|false>}
// On any failure it prints a message to stderr, writes nothing to stdout, and exits 1.

import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

// Reads one global, main-element property of an audio object into `value`.
// Fails unless CoreAudio returns noErr and exactly the expected number of bytes.
func readProperty<T>(
    _ object: AudioObjectID,
    _ selector: AudioObjectPropertySelector,
    _ value: inout T,
    _ what: String
) {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let expected = UInt32(MemoryLayout<T>.size)
    var size = expected
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    if status != noErr { fail("\(what) failed: OSStatus \(status)") }
    if size != expected { fail("\(what) returned \(size) bytes, expected \(expected)") }
}

var deviceID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
readProperty(
    AudioObjectID(kAudioObjectSystemObject),
    kAudioHardwarePropertyDefaultOutputDevice,
    &deviceID,
    "default output lookup"
)
if deviceID == AudioObjectID(kAudioObjectUnknown) { fail("no default output device") }

var nameRef: Unmanaged<CFString>? = nil
readProperty(deviceID, kAudioObjectPropertyName, &nameRef, "device name read")
guard let retainedName = nameRef else { fail("device name missing") }
let name = retainedName.takeRetainedValue() as String
if name.isEmpty { fail("device name is empty") }

var running: UInt32 = 0
readProperty(
    deviceID,
    kAudioDevicePropertyDeviceIsRunningSomewhere,
    &running,
    "running read"
)
if running > 1 { fail("running flag was \(running), expected 0 or 1") }

let report: [String: Any] = [
    "deviceId": Int(deviceID),
    "name": name,
    "running": running == 1,
]
do {
    var line = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    line.append(0x0A)
    FileHandle.standardOutput.write(line)
} catch {
    fail("could not encode the device report: \(error)")
}
exit(0)
