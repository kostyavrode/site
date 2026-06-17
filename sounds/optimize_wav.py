"""Convert SFX WAV to mono 22050 Hz 16-bit PCM for smaller downloads."""
import struct
import wave
from pathlib import Path

TARGET_SR = 22050
SOUNDS_DIR = Path(__file__).resolve().parent


def read_wav(path: Path):
    with wave.open(str(path), "rb") as w:
        channels = w.getnchannels()
        sample_rate = w.getframerate()
        sample_width = w.getsampwidth()
        nframes = w.getnframes()
        raw = w.readframes(nframes)
    if sample_width != 2:
        raise ValueError(f"{path.name}: expected 16-bit PCM")
    samples = list(struct.unpack("<" + "h" * (len(raw) // 2), raw))
    if channels == 2:
        samples = [(samples[i] + samples[i + 1]) // 2 for i in range(0, len(samples), 2)]
    elif channels != 1:
        raise ValueError(f"{path.name}: unsupported channel count {channels}")
    return samples, sample_rate


def resample(samples, src_sr, dst_sr):
    if src_sr == dst_sr:
        return samples
    if not samples:
        return samples
    ratio = src_sr / dst_sr
    out_len = max(1, int(len(samples) / ratio))
    out = []
    for i in range(out_len):
        pos = i * ratio
        idx = int(pos)
        frac = pos - idx
        s0 = samples[min(idx, len(samples) - 1)]
        s1 = samples[min(idx + 1, len(samples) - 1)]
        out.append(int(s0 * (1 - frac) + s1 * frac))
    return out


def trim_silence(samples, threshold=300, pad_ms=30, sample_rate=TARGET_SR):
    if not samples:
        return samples
    mx = max(abs(s) for s in samples)
    thr = max(threshold, int(mx * 0.015))
    start = next((i for i, s in enumerate(samples) if abs(s) > thr), 0)
    end = next((i for i in range(len(samples) - 1, -1, -1) if abs(samples[i]) > thr), len(samples) - 1)
    pad = int(sample_rate * pad_ms / 1000)
    start = max(0, start - pad)
    end = min(len(samples) - 1, end + pad)
    return samples[start : end + 1]


def write_wav(path: Path, samples, sample_rate):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(struct.pack("<" + "h" * len(samples), *samples))


def optimize_file(path: Path):
    before = path.stat().st_size
    samples, sr = read_wav(path)
    samples = resample(samples, sr, TARGET_SR)
    samples = trim_silence(samples, sample_rate=TARGET_SR)
    write_wav(path, samples, TARGET_SR)
    after = path.stat().st_size
    dur = len(samples) / TARGET_SR
    print(f"{path.name}: {before // 1024}KB -> {after // 1024}KB, {dur:.2f}s mono @{TARGET_SR}Hz")


def main():
    for wav in sorted(SOUNDS_DIR.glob("*.wav")):
        optimize_file(wav)


if __name__ == "__main__":
    main()
