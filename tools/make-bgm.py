# オリジナルBGMを数式だけで合成する（外部素材は一切使わない）
import numpy as np, subprocess, sys, os
from scipy.signal import fftconvolve, butter, lfilter
SR = 44100
OUT = sys.argv[1]
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
class Mix:
    def __init__(s, secs): s.b = np.zeros((int(secs * SR) + SR * 4, 2))
    def add(s, t, x, pan=0.0, g=1.0):
        i = int(t * SR)
        if i < 0 or i >= len(s.b): return
        n = min(len(x), len(s.b) - i)
        s.b[i:i+n, 0] += x[:n] * g * np.cos((pan + 1) * np.pi / 4)
        s.b[i:i+n, 1] += x[:n] * g * np.sin((pan + 1) * np.pi / 4)
def tt(d): return np.arange(int(d * SR)) / SR
def pluck(m, d=0.9, bright=5):
    t = tt(d); f = hz(m); x = np.zeros_like(t)
    for k in range(1, bright + 1):
        x += np.sin(2*np.pi*f*k*t) / k**1.6 * np.exp(-t * (3 + 2.2*k))
    return x * np.minimum(1, t / 0.004)
def epiano(m, d=1.8):
    t = tt(d); f = hz(m)
    x = np.sin(2*np.pi*f*t + 1.4*np.exp(-t*6)*np.sin(2*np.pi*f*2*t)) * np.exp(-t*2.2)
    x += 0.25*np.sin(2*np.pi*f*2*t) * np.exp(-t*5)
    return x * np.minimum(1, t/0.006) * np.minimum(1, (d - t)/0.05)
def pad(m, d, a=0.8, r=1.2):
    t = tt(d + r); f = hz(m); x = np.zeros_like(t)
    for det in (-0.004, 0, 0.004):
        for k, amp in ((1, 1), (2, .35), (3, .18), (4, .07)):
            x += amp*np.sin(2*np.pi*f*(1+det)*k*t + k)
    env = np.minimum(1, t/a) * np.minimum(1, np.maximum(0, (d + r - t)/r))
    return x/3 * env
def bass(m, d):
    t = tt(d); f = hz(m)
    x = np.sin(2*np.pi*f*t) + .3*np.sin(2*np.pi*2*f*t)*np.exp(-t*4)
    return x * np.minimum(1, t/0.01) * np.minimum(1, (d - t)/0.06) * np.exp(-t*0.8)
def kick():
    t = tt(0.32); ph = 2*np.pi*(45*t + (120-45)/18*(1-np.exp(-18*t)))
    return np.sin(ph) * np.exp(-t*11)
rng = np.random.default_rng(7)
def hat(d=0.05):
    t = tt(d*4); n = rng.standard_normal(len(t)); b, a = butter(2, 7000/(SR/2), 'high')
    return lfilter(b, a, n) * np.exp(-t/d) * 0.5
def snare():
    t = tt(0.25); n = rng.standard_normal(len(t)); b, a = butter(2, [900/(SR/2), 6000/(SR/2)], 'band')
    return lfilter(b, a, n)*np.exp(-t*16)*0.9 + 0.4*np.sin(2*np.pi*185*t)*np.exp(-t*22)
def shaker():
    t = tt(0.12); n = rng.standard_normal(len(t)); b, a = butter(2, 5000/(SR/2), 'high')
    return lfilter(b, a, n) * np.sin(np.pi*np.minimum(1, t/0.1))**2 * 0.3
def reverb(x, secs=1.8, wet=0.22, seed=1):
    r = np.random.default_rng(seed); n = int(secs*SR); t = np.arange(n)/SR
    out = np.empty_like(x)
    for c in range(2):
        ir = r.standard_normal(n) * np.exp(-t*(6.5/secs)); ir[:int(0.012*SR)] = 0
        ir /= np.sqrt((ir**2).sum())
        out[:, c] = x[:, c] + wet * fftconvolve(x[:, c], ir)[:len(x)]
    return out
def finish(mx, total, name, fade_in=0.05, fade_out=4.0, lp=None, wet=0.22, rv=1.8):
    x = reverb(mx.b, rv, wet)[:int(total*SR)]
    if lp:
        b, a = butter(2, lp/(SR/2)); x = lfilter(b, a, x, axis=0)
    t = np.arange(len(x))/SR
    env = np.minimum(1, t/fade_in) * np.minimum(1, (total - t)/fade_out)
    x *= env[:, None]
    x = x / np.percentile(np.abs(x), 99.7) * 0.7
    x = np.tanh(x * 1.1) / np.tanh(1.1) * 0.89
    raw = (x * 32767).astype('<i2').tobytes()
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 's16le', '-ar', str(SR), '-ac', '2', '-i', '-',
                    '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-b:a', '112k',
                    '-metadata', 'title=' + name[1], '-metadata', 'artist=Omoide Reel (CC0)',
                    os.path.join(OUT, name[0] + '.mp3')], input=raw, check=True)
    print(name[0], round(total, 1), 's')

PENT = [0, 2, 4, 7, 9]
def melody(r, root, bars, per_bar, lo=72, hi=88, rest=0.25):
    """ペンタトニックの順次進行メロディ（小節頭はコードトーン寄り）"""
    notes = [root + 12*o + p for o in range(-1, 4) for p in PENT]
    notes = [n for n in notes if lo <= n <= hi]
    i = len(notes)//2; out = []
    for b in range(bars):
        for s in range(per_bar):
            if s and r.random() < rest: out.append(None); continue
            i = int(np.clip(i + r.choice([-2, -1, -1, 0, 1, 1, 2]), 0, len(notes)-1))
            out.append(notes[i])
    return out

def sunny():
    bpm = 116; beat = 60/bpm; bar = 4*beat; bars = 44; mx = Mix(bars*bar)
    prog = [(48, [60, 64, 67]), (43, [59, 62, 67]), (45, [60, 64, 69]), (41, [60, 65, 69])]
    r = np.random.default_rng(11); mel = melody(r, 60, 8, 8, 72, 91, 0.3)
    for b in range(bars):
        t0 = b*bar; root, ch = prog[b % 4]; sec = b // 4
        full = 1 <= sec <= 9 and sec != 5
        for n in ch: mx.add(t0, pad(n, bar, 0.3, 0.6), 0, 0.10)
        for s in range(8):
            n = ch[[0, 1, 2, 1, 0, 2, 1, 2][s]] + 12
            mx.add(t0 + s*beat/2, pluck(n, 0.5), -0.4 if s % 2 else 0.4, 0.22)
        if sec >= 1:
            for s in (0, 1.5, 2, 3.5): mx.add(t0 + s*beat, bass(root - 12 if root > 44 else root, beat*0.45), 0, 0.5)
        if full:
            for s in range(4): mx.add(t0 + s*beat, kick(), 0, 0.75)
            for s in (1, 3): mx.add(t0 + s*beat, snare(), 0.05, 0.28)
            for s in range(8): mx.add(t0 + s*beat/2 + beat/4*0, hat(0.03 if s % 2 == 0 else 0.05), 0.3, 0.22 if s % 2 else 0.12)
        if sec >= 2 and sec != 5:
            for s in range(8):
                n = mel[((b % 8)*8 + s)]
                if n: mx.add(t0 + s*beat/2, pluck(n, 0.7, 7), 0.15, 0.30)
    finish(mx, bars*bar, ('sunny-steps', 'Sunny Steps'), wet=0.16, rv=1.2)

def golden():
    bpm = 84; beat = 60/bpm; bar = 4*beat; bars = 32; mx = Mix(bars*bar)
    prog = [(41, [57, 60, 64, 65]), (40, [55, 59, 62, 64]), (38, [57, 60, 62, 65]), (36, [55, 59, 60, 64])]
    r = np.random.default_rng(23); mel = melody(r, 60, 8, 4, 72, 86, 0.3)
    for b in range(bars):
        t0 = b*bar; root, ch = prog[b % 4]; sec = b // 4
        for k, n in enumerate(ch): mx.add(t0 + k*0.035, epiano(n, bar*0.95), (k-1.5)*0.25, 0.26)
        for n in ch[1:3]: mx.add(t0 + 2.5*beat, epiano(n + 12, beat*1.4), 0.3, 0.14)
        for n in ch[:3]: mx.add(t0, pad(n, bar, 1.0, 1.0), 0, 0.05)
        if sec >= 1:
            mx.add(t0, bass(root, beat*1.8), 0, 0.5); mx.add(t0 + 2.5*beat, bass(root, beat*1.2), 0, 0.4)
        if 2 <= sec <= 6:
            mx.add(t0, kick(), 0, 0.5); mx.add(t0 + 2.5*beat, kick(), 0, 0.35)
            for s in range(8): mx.add(t0 + s*beat/2, shaker(), -0.3, 0.5 if s % 2 else 0.3)
            for s in (1, 3): mx.add(t0 + s*beat, snare(), 0, 0.12)
        if sec >= 1:
            for s in range(4):
                n = mel[(b % 8)*4 + s]
                if n: mx.add(t0 + s*beat + (beat/2 if s % 2 else 0)*0.5, epiano(n, beat*1.6), -0.1, 0.30)
    finish(mx, bars*bar, ('golden-hour', 'Golden Hour'), lp=6500, wet=0.25, rv=2.0)

def breeze():
    bpm = 66; beat = 60/bpm; bar = 4*beat; bars = 26; mx = Mix(bars*bar)
    prog = [(38, [62, 66, 69, 73]), (35, [62, 66, 69, 71]), (43, [62, 66, 67, 71]), (45, [61, 64, 69, 71])]
    r = np.random.default_rng(5); mel = melody(r, 62, 8, 4, 76, 93, 0.45)
    for b in range(bars):
        t0 = b*bar; root, ch = prog[b % 4]
        for n in ch: mx.add(t0, pad(n, bar, 1.6, 2.2), 0, 0.12)
        mx.add(t0, pad(root, bar, 1.2, 1.8), 0, 0.22)
        if b >= 2:
            for s in range(8):
                n = ch[[0, 2, 1, 3, 2, 1, 3, 2][s]] + 12
                mx.add(t0 + s*beat/2, pluck(n, 1.4, 3), np.sin(s*1.3)*0.6, 0.16)
        if b >= 6:
            for s in range(4):
                n = mel[(b % 8)*4 + s]
                if n: mx.add(t0 + s*beat, pluck(n, 2.2, 4), 0.2, 0.2)
    finish(mx, bars*bar, ('blue-breeze', 'Blue Breeze'), fade_in=1.5, fade_out=6, wet=0.4, rv=3.0)

def night():
    bpm = 76; beat = 60/bpm; bar = 4*beat; bars = 30; mx = Mix(bars*bar); sw = beat*0.16
    prog = [(38, [60, 64, 65, 69]), (43, [59, 64, 65, 69]), (36, [59, 62, 64, 67]), (45, [61, 64, 67, 71])]
    r = np.random.default_rng(31); mel = melody(r, 57, 8, 4, 69, 84, 0.4)
    for b in range(bars):
        t0 = b*bar; root, ch = prog[b % 4]; sec = b // 4
        for k, n in enumerate(ch): mx.add(t0 + k*0.05, epiano(n, bar*0.9), (k-1.5)*0.2, 0.24)
        for n in ch[1:]: mx.add(t0 + 1.5*beat + sw, epiano(n, beat*0.8), 0.2, 0.12)
        if sec >= 1:
            mx.add(t0, bass(root, beat*1.4), 0, 0.55); mx.add(t0 + 1.5*beat + sw, bass(root, beat*0.5), 0, 0.4)
            mx.add(t0 + 2.5*beat + sw, bass(root + 7 if root < 42 else root - 5, beat*0.9), 0, 0.4)
            mx.add(t0, kick(), 0, 0.6); mx.add(t0 + 2.5*beat + sw, kick(), 0, 0.45)
            for s in (1, 3): mx.add(t0 + s*beat, snare(), 0, 0.3)
            for s in range(8): mx.add(t0 + s*beat/2 + (sw if s % 2 else 0), hat(0.025), 0.35, 0.2 if s % 2 == 0 else 0.11)
        if sec >= 2:
            for s in range(4):
                n = mel[(b % 8)*4 + s]
                if n: mx.add(t0 + s*beat + (sw if s % 2 else 0), epiano(n + 12, beat*1.2), -0.25, 0.2)
    finish(mx, bars*bar, ('night-lights', 'Night Lights'), lp=4200, wet=0.2, rv=1.6)
sunny(); golden(); breeze(); night()
