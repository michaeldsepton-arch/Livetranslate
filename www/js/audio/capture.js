// Microphone capture -> 16 kHz mono Float32 blocks.
import { Resampler } from "./resample.js";

export class MicCapture {
  /**
   * @param {{onSamples:(f:Float32Array)=>void, onError?:(msg:string)=>void, noiseSuppression?:boolean, autoGain?:boolean}} o
   */
  constructor({ onSamples, onError = () => {}, noiseSuppression = true, autoGain = true }) {
    Object.assign(this, { onSamples, onError, noiseSuppression, autoGain });
    this.running = false;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This device cannot access the microphone.");
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: this.noiseSuppression, autoGainControl: this.autoGain },
      });
    } catch (e) {
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      throw new Error(denied ? "Microphone permission was denied. Allow it in your phone's settings for Lisan." : `Could not open the microphone (${e && e.name ? e.name : e}).`);
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: "interactive" });
    await this.ctx.resume();
    this.resampler = new Resampler(this.ctx.sampleRate, 16000);
    const handle = (block) => {
      if (this.running) this.onSamples(this.resampler.process(block));
    };

    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0; // keep the graph alive without playing the mic through the speaker
    this.sink.connect(this.ctx.destination);

    let node;
    try {
      await this.ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url).href);
      node = new AudioWorkletNode(this.ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e) => handle(e.data);
    } catch {
      node = this.ctx.createScriptProcessor(4096, 1, 1); // older WebViews
      node.onaudioprocess = (e) => handle(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    this.node = node;
    this.src.connect(node);
    node.connect(this.sink);
    this.running = true;

    const track = this.stream.getAudioTracks()[0];
    if (track) track.onended = () => this.running && this.onError("The microphone stopped (another app may have taken it).");
  }

  stop() {
    this.running = false;
    try { this.node && this.node.disconnect(); } catch {}
    try { this.src && this.src.disconnect(); } catch {}
    try { this.sink && this.sink.disconnect(); } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx && this.ctx.close(); } catch {}
    this.stream = this.ctx = this.node = this.src = null;
  }
}
