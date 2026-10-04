/*
 * RNNoise 0.2 — AudioWorklet-процессор шумоподавления (48 кГц, моно) с гейтом по VAD.
 *
 * rnnoise-sync.js — синхронная сборка из @jitsi/rnnoise-wasm@0.2.1
 * (https://github.com/jitsi/rnnoise-wasm, Apache-2.0), WASM встроен в файл.
 *
 * Сообщения в основной поток: { type: 'ready' } | { type: 'error', message }
 */
import createRNNWasmModuleSync from './rnnoise-sync.js';

const FRAME = 480; // 10 мс при 48 кГц
const QUANTUM = 128;
const PCM_SCALE = 32768; // RNNoise ждёт float в диапазоне int16

// Гейт: RNNoise на каждый кадр возвращает вероятность речи. Пока речи нет дольше GATE_HOLD_FRAMES —
// плавно приглушаем остаточный шум до GATE_FLOOR.
const GATE_OPEN_VAD = 0.35;
const GATE_HOLD_FRAMES = 30; // 300 мс «хвоста» после речи
const GATE_FLOOR = 0.1; // -20 дБ
const GATE_RELEASE_STEP = 0.1; // закрытие за ~90 мс

class RnnoiseProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.isInitialized = false;
        const opts = (options && options.processorOptions) || {};
        this.vadGate = opts.vadGate !== false;
        try {
            this.module = createRNNWasmModuleSync();
            this.state = this.module._rnnoise_create();
            this.pcmPtr = this.module._malloc(FRAME * 4);
            this.bufferSize = FRAME * 4;
            this.inputBuffer = new Float32Array(this.bufferSize);
            this.outputBuffer = new Float32Array(this.bufferSize);
            this.inputWritePos = 0;
            this.inputReadPos = 0;
            this.outputWritePos = 0;
            this.outputReadPos = 0;
            this.holdFrames = 0;
            this.gateGain = 1;
            this.isInitialized = true;
            this.port.postMessage({ type: 'ready' });
        } catch (error) {
            this.port.postMessage({ type: 'error', message: String(error && error.message || error) });
        }
    }

    available(writePos, readPos) {
        return (writePos - readPos + this.bufferSize) % this.bufferSize;
    }

    processFrame() {
        // HEAPF32 перечитываем каждый кадр: при росте памяти WASM старый view отсоединяется
        const heap = this.module.HEAPF32;
        const base = this.pcmPtr >> 2;
        for (let i = 0; i < FRAME; i++) {
            heap[base + i] = this.inputBuffer[this.inputReadPos] * PCM_SCALE;
            this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;
        }
        const vad = this.module._rnnoise_process_frame(this.state, this.pcmPtr, this.pcmPtr);
        const out = this.module.HEAPF32;

        let targetGain = 1;
        if (this.vadGate) {
            if (vad >= GATE_OPEN_VAD) {
                this.holdFrames = GATE_HOLD_FRAMES;
            } else if (this.holdFrames > 0) {
                this.holdFrames--;
            }
            // Открываемся сразу (в пределах кадра), закрываемся плавно
            targetGain = this.holdFrames > 0 ? 1 : Math.max(GATE_FLOOR, this.gateGain - GATE_RELEASE_STEP);
        }
        const startGain = this.gateGain;
        const gainStep = (targetGain - startGain) / FRAME;
        for (let i = 0; i < FRAME; i++) {
            this.outputBuffer[this.outputWritePos] = (out[base + i] / PCM_SCALE) * (startGain + gainStep * i);
            this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;
        }
        this.gateGain = targetGain;
    }

    process(inputList, outputList) {
        const input = inputList[0] && inputList[0][0];
        const output = outputList[0];
        if (!input || !output) {
            return true;
        }

        if (!this.isInitialized) {
            for (let ch = 0; ch < output.length; ch++) {
                output[ch].set(input);
            }
            return true;
        }

        for (let i = 0; i < input.length; i++) {
            this.inputBuffer[this.inputWritePos] = input[i];
            this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;
        }

        while (this.available(this.inputWritePos, this.inputReadPos) >= FRAME) {
            this.processFrame();
        }

        // Пока обработанных сэмплов меньше кванта — отдаём тишину (только на старте)
        if (this.available(this.outputWritePos, this.outputReadPos) >= QUANTUM) {
            for (let ch = 0; ch < output.length; ch++) {
                const channel = output[ch];
                let readPos = this.outputReadPos;
                for (let i = 0; i < QUANTUM; i++) {
                    channel[i] = this.outputBuffer[readPos];
                    readPos = (readPos + 1) % this.bufferSize;
                }
            }
            this.outputReadPos = (this.outputReadPos + QUANTUM) % this.bufferSize;
        }
        return true;
    }
}

registerProcessor('rnnoise2-processor', RnnoiseProcessor);
