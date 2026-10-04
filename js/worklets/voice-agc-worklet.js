/*
 * Автоусиление голоса ПОСЛЕ шумоподавителя (моно).
 *
 * Браузерное AGC стоит до шумоподавителя и в паузах вытягивает шум. Здесь уровень меряется
 * только по речи (на очищенном сигнале паузы — почти тишина), усиление в паузах заморожено.
 * На выходе — пиковый лимитер, чтобы усиленный сигнал не клиповал.
 */
const TARGET_LEVEL = 0.12; // целевой RMS громких слогов (~ -18 dBFS)
const SPEECH_THRESHOLD = 0.003; // блок считается речью выше ~ -50 dBFS
const MIN_GAIN = 0.5; // -6 дБ
const MAX_GAIN = 6; // +15.5 дБ
const MIN_SPEECH_SECONDS = 0.3; // до этого усиление не трогаем — уровень ещё не измерен
const LEVEL_ATTACK_S = 0.15;
const LEVEL_RELEASE_S = 2.5;
const GAIN_DOWN_S = 0.3;
const GAIN_UP_S = 1.0;
const LIMIT_PEAK = 0.95;
const LIMIT_RELEASE_S = 0.1;

class VoiceAgcProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.level = TARGET_LEVEL;
        this.speechSeconds = 0;
        this.gain = 1;
        this.limiterGain = 1;
        this.lastTotalGain = 1;
    }

    process(inputList, outputList) {
        const input = inputList[0] && inputList[0][0];
        const output = outputList[0];
        if (!input || !output) {
            return true;
        }

        const n = input.length;
        const dt = n / sampleRate;
        let sumSquares = 0;
        let peak = 0;
        for (let i = 0; i < n; i++) {
            const sample = input[i];
            sumSquares += sample * sample;
            const abs = sample < 0 ? -sample : sample;
            if (abs > peak) {
                peak = abs;
            }
        }
        const rms = Math.sqrt(sumSquares / n);

        if (rms > SPEECH_THRESHOLD) {
            const warmingUp = this.speechSeconds < MIN_SPEECH_SECONDS;
            if (this.speechSeconds === 0) {
                this.level = rms;
            }
            // На разогреве быстро меряем уровень в обе стороны, иначе тихий микрофон «разгонялся» бы десяток секунд
            const tau = (warmingUp || rms > this.level) ? LEVEL_ATTACK_S : LEVEL_RELEASE_S;
            this.level += (1 - Math.exp(-dt / tau)) * (rms - this.level);
            this.speechSeconds += dt;

            if (!warmingUp) {
                const desired = Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET_LEVEL / this.level));
                const gainTau = desired < this.gain ? GAIN_DOWN_S : GAIN_UP_S;
                this.gain += (1 - Math.exp(-dt / gainTau)) * (desired - this.gain);
            }
        }

        // Лимитер: срабатывает мгновенно, отпускает плавно
        this.limiterGain += (1 - Math.exp(-dt / LIMIT_RELEASE_S)) * (1 - this.limiterGain);
        if (peak * this.gain * this.limiterGain > LIMIT_PEAK) {
            this.limiterGain = LIMIT_PEAK / (peak * this.gain);
        }

        const totalGain = this.gain * this.limiterGain;
        const startGain = this.lastTotalGain;
        const gainStep = (totalGain - startGain) / n;
        const out = output[0];
        for (let i = 0; i < n; i++) {
            const sample = input[i] * (startGain + gainStep * (i + 1));
            out[i] = sample > 1 ? 1 : (sample < -1 ? -1 : sample);
        }
        for (let ch = 1; ch < output.length; ch++) {
            output[ch].set(out);
        }
        this.lastTotalGain = totalGain;
        return true;
    }
}

registerProcessor('voice-agc-processor', VoiceAgcProcessor);
