// Microphone loudness only: no recording, no speech recognition, nothing leaves the tablet.
export class Listener {
  constructor() { this.ctx = null; this.stream = null; this.analyser = null; this.buf = null; this.level = 0; }
  get active() { return !!this.stream; }
  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buf = new Float32Array(this.analyser.fftSize);
    src.connect(this.analyser);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }
  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) this.ctx.close();
    this.stream = null; this.ctx = null; this.analyser = null; this.level = 0;
  }
  // loudness 0..100 (dBFS mapped from -70..-10)
  read() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0; for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const v = Math.max(0, Math.min(100, (db + 70) / 60 * 100));
    this.level = this.level * 0.6 + v * 0.4;
    return this.level;
  }
}
