const { EventEmitter } = require('node:events')
class SerialPort extends EventEmitter {
  static ports = []
  constructor(options) { super(); this.options = options; this.isOpen = false; this.paused = false; SerialPort.ports.push(this) }
  open(done) { this.isOpen = true; setImmediate(() => done(null)) }
  close(done) { this.isOpen = false; this.emit('close'); done?.() }
  pause() { this.paused = true }
  resume() { this.paused = false }
  write() {}
  set(_bits, done) { done(null) }
  get(done) { done(null, {}) }
  static async list() { return [] }
}
exports.SerialPort = SerialPort
