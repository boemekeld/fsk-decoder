const fs = require('fs')
const path = require('path')
const chokidar = require('chokidar')
const mqtt = require('mqtt')

const POWER_THRESHOLD = 5
const MIN_SIGNAL_LENGTH = 35000
const SAMPLES_PER_BIT = 635

const PREAMBLE_LENGTH = 24
const SYNC_WORD_LENGTH = 16
const DEVICE_ID_LENGTH = 20
const COMMAND_LENGTH = 3
const BATTERY_LENGTH = 1

const SYNC_WORD = '0010110111010100'
const COMMANDS = { '001': 'OPEN', '010': 'CLOSE' }
const BATTERY_STATUS = { '1': 'OK', '0': 'LOW' }

const DISCOVERY_PREFIX = 'homeassistant'

class MqttClient {
  constructor(url, options) {
    this.client = mqtt.connect(url, options)
    this.client.setMaxListeners(0)
  }

  send(topic, message, options = {}) {
    if (this.client.connected) {
      this.client.publish(topic, message, options)
    } else {
      this.client.once('connect', () => this.client.publish(topic, message, options))
    }
  }
}

class SignalProcessor {
  static readIq(file) {
    const buffer = fs.readFileSync(file)
    const len = buffer.length / 2
    const I = new Uint8Array(len)
    const Q = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      I[i] = buffer[2 * i]
      Q[i] = buffer[2 * i + 1]
    }
    return { I, Q }
  }

  static normalize({ I, Q }) {
    const len = I.length
    const nI = new Float32Array(len)
    const nQ = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      nI[i] = I[i] - 128
      nQ[i] = Q[i] - 128
    }
    return { I: nI, Q: nQ }
  }

  static calculatePower({ I, Q }) {
    const len = I.length
    const p = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      p[i] = I[i] * I[i] + Q[i] * Q[i]
    }
    return p
  }

  static aboveThreshold(power, threshold) {
    return Array.from(power, v => v > threshold)
  }

  static findIntervals(flags, minLen) {
    const intervals = []
    let start = null
    flags.forEach((f, i) => {
      if (f && start === null) start = i
      if (!f && start !== null) {
        if (i - start >= minLen) intervals.push([start, i - 1])
        start = null
      }
    })
    if (start !== null && flags.length - start >= minLen) {
      intervals.push([start, flags.length - 1])
    }
    return intervals
  }

  static computePhases({ I, Q }) {
    const len = I.length
    const phases = new Float64Array(len)
    for (let i = 0; i < len; i++) {
      phases[i] = Math.atan2(Q[i], I[i])
    }
    return phases
  }

  static computeDiffs(phases) {
    const len = phases.length
    const diffs = new Float32Array(len)
    for (let i = 1; i < len; i++) {
      let d = phases[i] - phases[i - 1]
      if (d > Math.PI) d -= 2 * Math.PI
      if (d < -Math.PI) d += 2 * Math.PI
      diffs[i] = d
    }
    return diffs
  }

  static decodeBits(diffs, [start, end], samplesPerBit) {
    const total = end - start + 1
    const symbols = Math.floor(total / samplesPerBit)
    const bits = []
    for (let s = 0; s < symbols; s++) {
      let sum = 0
      const offset = start + s * samplesPerBit
      for (let k = 0; k < samplesPerBit; k++) {
        sum += diffs[offset + k]
      }
      bits.push(sum > 0 ? '1' : '0')
    }
    return bits
  }

  static extractSequences(file, threshold, minLen, samplesPerBit) {
    const raw = this.readIq(file)
    const norm = this.normalize(raw)
    const power = this.calculatePower(norm)
    const flags = this.aboveThreshold(power, threshold)
    const intervals = this.findIntervals(flags, minLen)
    if (!intervals.length) return []
    const phases = this.computePhases(norm)
    const diffs = this.computeDiffs(phases)
    const validLen = PREAMBLE_LENGTH + SYNC_WORD_LENGTH + DEVICE_ID_LENGTH + COMMAND_LENGTH + BATTERY_LENGTH
    const sequences = new Set()
    intervals.forEach(interval => {
      const bits = this.decodeBits(diffs, interval, samplesPerBit)
      if (bits.length === validLen) sequences.add(bits.join(''))
    })
    return [...sequences]
  }
}

class FrameParser {
  static parse(frame) {
    const pre = frame.slice(0, PREAMBLE_LENGTH)
    const sync = frame.slice(PREAMBLE_LENGTH, PREAMBLE_LENGTH + SYNC_WORD_LENGTH)
    const idStart = PREAMBLE_LENGTH + SYNC_WORD_LENGTH
    const deviceId = '0x' + FrameParser.binToHex(frame.slice(idStart, idStart + DEVICE_ID_LENGTH))
    const cmdStart = idStart + DEVICE_ID_LENGTH
    const commandBits = frame.slice(cmdStart, cmdStart + COMMAND_LENGTH)
    const batteryBit = frame.slice(cmdStart + COMMAND_LENGTH, cmdStart + COMMAND_LENGTH + BATTERY_LENGTH)
    return {
      sync,
      deviceId,
      command: COMMANDS[commandBits] || 'UNKNOWN',
      battery: BATTERY_STATUS[batteryBit] || 'UNKNOWN'
    }
  }
  static binToHex(b) {
    b = b.padStart(Math.ceil(b.length / 4) * 4, '0');
    let h = '';
    for (let i = 0; i < b.length; i += 4)
      h += parseInt(b.slice(i, i + 4), 2).toString(16);
    return h;
  }
}

const mqttClient = new MqttClient('mqtt://homeassistant.local', {
  username: 'XXX',
  password: 'YYY'
})

const discovered = new Set()

function publishDiscovery(deviceId) {
  const baseTopic = `rtl_433/${deviceId}`
  mqttClient.send(
    `${DISCOVERY_PREFIX}/binary_sensor/${deviceId}/contact/config`,
    JSON.stringify({
      "device":{
        "manufacturer":"Intelbras",
        "model":"Door sensor",
        "model_id":"XAS 4010 Smart",
        identifiers: [deviceId],
        "name":"Door sensor " + deviceId,
      },
      "device_class":"door",
      "object_id": deviceId + "_contact",
      "origin":{
        "name":"SDR2MQTT",
      },
      "payload_off": false,
      "payload_on": true,
      "state_topic":baseTopic,
      "unique_id": deviceId + "_contact",
      "value_template":"{{ value_json.contact }}"
    }),
    { retain: true }
  )
  mqttClient.send(
    `${DISCOVERY_PREFIX}/binary_sensor/${deviceId}/battery_low/config`,
    JSON.stringify({
      "device":{
        "manufacturer":"Intelbras",
        "model":"Door sensor",
        "model_id":"XAS 4010 Smart",
        identifiers: [deviceId],
        "name":"Door sensor " + deviceId,
      },
      "device_class":"battery",
      "entity_category":"diagnostic",
      "object_id": deviceId + "_battery_low",
      "origin":{
        "name":"SDR2MQTT",
      },
      "payload_off": false,
      "payload_on": true,
      "state_topic":baseTopic,
      "unique_id": deviceId + "_battery_low",
      "value_template":"{{ value_json.battery_low }}"
    }),
    { retain: true }
  )
  discovered.add(deviceId)
}

function processFile(file) {
  const frames = SignalProcessor.extractSequences(
    file,
    POWER_THRESHOLD,
    MIN_SIGNAL_LENGTH,
    SAMPLES_PER_BIT
  )
  frames.forEach(frameBits => {
    const { sync, deviceId, command, battery } = FrameParser.parse(frameBits)
    if (sync !== SYNC_WORD) return
    if (!discovered.has(deviceId)) publishDiscovery(deviceId)
    const baseTopic = `rtl_433/${deviceId}`
    mqttClient.send(`${baseTopic}`, JSON.stringify({
      contact: command == "OPEN",
      battery_low: battery == "LOW"
    }));
    console.log(deviceId, command, battery);
  })
}

chokidar
  .watch(__dirname, { ignoreInitial: true })
  .on('add', file => {
    if (path.extname(file).toLowerCase() === '.cu8') {
      processFile(file)
    }
  })
