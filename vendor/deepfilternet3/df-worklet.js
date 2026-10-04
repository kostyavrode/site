/*
 * DeepFilterNet 3 — AudioWorklet-процессор шумоподавления (48 кГц, моно).
 *
 * wasm-bindgen-обвязка и df_bg.wasm взяты из пакета deepfilternet3-noise-filter@1.3.0
 * (https://github.com/mezonai/mezon-noise-suppression, Apache-2.0 OR MIT) — это сборка
 * libDF из https://github.com/Rikorose/DeepFilterNet (Apache-2.0 OR MIT).
 * Модель DeepFilterNet3_onnx.tar.gz — из официального репозитория Rikorose/DeepFilterNet.
 */
(function () {
    'use strict';

    /* @ts-self-types="./df.d.ts" */

    // --- AudioWorklet polyfill ---------------------------------------------------
    // AudioWorkletGlobalScope has no TextDecoder/TextEncoder. wasm-bindgen 0.2.126
    // constructs `new TextDecoder()` at module top-level (unguarded), which throws
    // `ReferenceError: TextDecoder is not defined` inside a worklet and prevents
    // registerProcessor() from running. Provide minimal UTF-8 shims when absent.
    // (Only used for error/diagnostic strings; the audio path passes bytes/floats.)
    if (typeof TextDecoder === 'undefined') {
        globalThis.TextDecoder = class {
            decode(bytes) {
                if (!bytes) return '';
                const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
                let out = '';
                for (let i = 0; i < u8.length;) {
                    const c = u8[i++];
                    if (c < 0x80) out += String.fromCharCode(c);
                    else if (c < 0xE0) out += String.fromCharCode(((c & 0x1F) << 6) | (u8[i++] & 0x3F));
                    else if (c < 0xF0) out += String.fromCharCode(((c & 0x0F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F));
                    else {
                        const cp = (((c & 0x07) << 18) | ((u8[i++] & 0x3F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F)) - 0x10000;
                        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
                    }
                }
                return out;
            }
        };
    }
    if (typeof TextEncoder === 'undefined') {
        globalThis.TextEncoder = class {
            encode(str) {
                const out = [];
                for (let i = 0; i < str.length; i++) {
                    let c = str.charCodeAt(i);
                    if (c < 0x80) out.push(c);
                    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
                    else if (c >= 0xD800 && c < 0xDC00) {
                        const c2 = str.charCodeAt(++i);
                        c = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
                        out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
                    } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
                }
                return new Uint8Array(out);
            }
            encodeInto(str, dst) {
                const enc = this.encode(str);
                dst.set(enc);
                return { read: str.length, written: enc.length };
            }
        };
    }

    /**
     * Create a DeepFilterNet Model
     *
     * Args:
     *     - path: File path to a DeepFilterNet tar.gz onnx model
     *     - atten_lim: Attenuation limit in dB.
     *
     * Returns:
     *     - DF state doing the full processing: stft, DNN noise reduction, istft.
     * @param {Uint8Array} model_bytes
     * @param {number} atten_lim
     * @returns {number}
     */
    function df_create(model_bytes, atten_lim) {
        const ptr0 = passArray8ToWasm0(model_bytes, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.df_create(ptr0, len0, atten_lim);
        return ret >>> 0;
    }

    /**
     * Get DeepFilterNet frame size in samples.
     * @param {number} st
     * @returns {number}
     */
    function df_get_frame_length(st) {
        const ret = wasm.df_get_frame_length(st);
        return ret >>> 0;
    }

    /**
     * Processes a chunk of samples.
     *
     * Args:
     *     - df_state: Created via df_create()
     *     - input: Input buffer of length df_get_frame_length()
     *     - output: Output buffer of length df_get_frame_length()
     *
     * Returns:
     *     - Local SNR of the current frame.
     * @param {number} st
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    function df_process_frame(st, input) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.df_process_frame(st, ptr0, len0);
        return ret;
    }

    /**
     * Set DeepFilterNet attenuation limit.
     *
     * Args:
     *     - lim_db: New attenuation limit in dB.
     * @param {number} st
     * @param {number} lim_db
     */
    function df_set_atten_lim(st, lim_db) {
        wasm.df_set_atten_lim(st, lim_db);
    }
    function __wbg_get_imports() {
        const import0 = {
            __proto__: null,
            __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
                throw new Error(getStringFromWasm0(arg0, arg1));
            },
            __wbg_getRandomValues_cc7f052a444bb2ce: function() { return handleError(function (arg0, arg1) {
                globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
            }, arguments); },
            __wbg_new_from_slice_ddf8b82c4d6af38e: function(arg0, arg1) {
                const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
                return ret;
            },
            __wbindgen_init_externref_table: function() {
                const table = wasm.__wbindgen_externrefs;
                const offset = table.grow(4);
                table.set(0, undefined);
                table.set(offset + 0, undefined);
                table.set(offset + 1, null);
                table.set(offset + 2, true);
                table.set(offset + 3, false);
            },
        };
        return {
            __proto__: null,
            "./df_bg.js": import0,
        };
    }

    (typeof FinalizationRegistry === 'undefined')
        ? { }
        : new FinalizationRegistry(ptr => wasm.__wbg_dfstate_free(ptr, 1));

    function addToExternrefTable0(obj) {
        const idx = wasm.__externref_table_alloc_command_export();
        wasm.__wbindgen_externrefs.set(idx, obj);
        return idx;
    }

    function getArrayF32FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
    }

    function getArrayU8FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
    }

    let cachedFloat32ArrayMemory0 = null;
    function getFloat32ArrayMemory0() {
        if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
            cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
        }
        return cachedFloat32ArrayMemory0;
    }

    function getStringFromWasm0(ptr, len) {
        return decodeText(ptr >>> 0, len);
    }

    let cachedUint8ArrayMemory0 = null;
    function getUint8ArrayMemory0() {
        if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
            cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
        }
        return cachedUint8ArrayMemory0;
    }

    function handleError(f, args) {
        try {
            return f.apply(this, args);
        } catch (e) {
            const idx = addToExternrefTable0(e);
            wasm.__wbindgen_exn_store_command_export(idx);
        }
    }

    function passArray8ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 1, 1) >>> 0;
        getUint8ArrayMemory0().set(arg, ptr / 1);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    function passArrayF32ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 4, 4) >>> 0;
        getFloat32ArrayMemory0().set(arg, ptr / 4);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    const MAX_SAFARI_DECODE_BYTES = 2146435072;
    let numBytesDecoded = 0;
    function decodeText(ptr, len) {
        numBytesDecoded += len;
        if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
            cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
            cachedTextDecoder.decode();
            numBytesDecoded = len;
        }
        return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
    }

    let WASM_VECTOR_LEN = 0;

    let wasm;
    function __wbg_finalize_init(instance, module) {
        wasm = instance.exports;
        cachedFloat32ArrayMemory0 = null;
        cachedUint8ArrayMemory0 = null;
        wasm.__wbindgen_start();
        return wasm;
    }

    function initSync(module) {
        if (wasm !== undefined) return wasm;


        if (module !== undefined) {
            if (Object.getPrototypeOf(module) === Object.prototype) {
                ({module} = module);
            } else {
                console.warn('using deprecated parameters for `initSync()`; pass a single object instead');
            }
        }

        const imports = __wbg_get_imports();
        if (!(module instanceof WebAssembly.Module)) {
            module = new WebAssembly.Module(module);
        }
        const instance = new WebAssembly.Instance(module, imports);
        return __wbg_finalize_init(instance);
    }

    // --- AudioWorkletProcessor ---------------------------------------------------
    // Сообщения в основной поток: { type: 'ready', frameLength } | { type: 'error', message }
    //                             | { type: 'stats', avgFrameMs } (раз в STATS_FRAMES кадров)
    // Сообщения из основного потока: { type: 'SET_SUPPRESSION_LEVEL', value } | { type: 'SET_BYPASS', value }
    const QUANTUM = 128;
    const STATS_FRAMES = 300;

    class DeepFilterAudioProcessor extends AudioWorkletProcessor {
        constructor(options) {
            super();
            this.handle = 0;
            this.frameLength = 0;
            this.bypass = false;
            this.isInitialized = false;
            this.statsFrames = 0;
            this.statsMs = 0;
            this.port.onmessage = (event) => this.handleMessage(event.data);
            try {
                const opts = options.processorOptions;
                initSync({ module: opts.wasmModule });
                this.handle = df_create(new Uint8Array(opts.modelBytes), opts.suppressionLevel ?? 100);
                this.frameLength = df_get_frame_length(this.handle);
                this.frame = new Float32Array(this.frameLength);
                this.bufferSize = this.frameLength * 4;
                this.inputBuffer = new Float32Array(this.bufferSize);
                this.outputBuffer = new Float32Array(this.bufferSize);
                this.inputWritePos = 0;
                this.inputReadPos = 0;
                this.outputWritePos = 0;
                this.outputReadPos = 0;
                this.isInitialized = true;
                this.port.postMessage({ type: 'ready', frameLength: this.frameLength });
            } catch (error) {
                this.port.postMessage({ type: 'error', message: String(error && error.message || error) });
            }
        }

        handleMessage(data) {
            if (!data) return;
            if (data.type === 'SET_SUPPRESSION_LEVEL' && this.isInitialized && typeof data.value === 'number') {
                df_set_atten_lim(this.handle, Math.max(0, Math.min(100, data.value)));
            } else if (data.type === 'SET_BYPASS') {
                this.bypass = Boolean(data.value);
            }
        }

        available(writePos, readPos) {
            return (writePos - readPos + this.bufferSize) % this.bufferSize;
        }

        process(inputList, outputList) {
            const input = inputList[0] && inputList[0][0];
            const output = outputList[0];
            if (!input || !output) {
                return true;
            }

            if (!this.isInitialized || this.bypass) {
                for (let ch = 0; ch < output.length; ch++) {
                    output[ch].set(input);
                }
                return true;
            }

            for (let i = 0; i < input.length; i++) {
                this.inputBuffer[this.inputWritePos] = input[i];
                this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;
            }

            const frameLength = this.frameLength;
            while (this.available(this.inputWritePos, this.inputReadPos) >= frameLength) {
                for (let i = 0; i < frameLength; i++) {
                    this.frame[i] = this.inputBuffer[this.inputReadPos];
                    this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;
                }
                const started = Date.now();
                const processed = df_process_frame(this.handle, this.frame);
                this.statsMs += Date.now() - started;
                if (++this.statsFrames >= STATS_FRAMES) {
                    this.port.postMessage({ type: 'stats', avgFrameMs: this.statsMs / this.statsFrames });
                    this.statsFrames = 0;
                    this.statsMs = 0;
                }
                for (let i = 0; i < processed.length; i++) {
                    this.outputBuffer[this.outputWritePos] = processed[i];
                    this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;
                }
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
    registerProcessor('deepfilter-audio-processor', DeepFilterAudioProcessor);

})();
