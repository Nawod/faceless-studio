"""Narration with word-level timings.

usage:
  python tts.py <text_file> <out_mp3> <out_json> --engine edge|google --voice NAME [--rate +6%]
  python tts.py --segments segs.json <out_mp3> <out_json> --engine edge --voice NAME
     segs.json: [{"text": "...", "rate": "+14%", "pitch": "+3Hz", "gap": 0.1}, ...]
     Each segment is voiced on its own (its own speed/pitch = livelier delivery), then joined with the given
     pause after it. Word timings carry a "seg" index, so scene timings are exact.
Writes the audio and a JSON list of {"word", "start", "end", "seg"} in seconds.
edge:   Microsoft Edge neural voices via edge-tts (free).
google: Google Cloud TTS (GOOGLE_TTS_API_KEY env), SSML <mark> per word for timings.
"""
import argparse, asyncio, base64, json, os, re, subprocess, sys, tempfile, urllib.request


async def edge(text, voice, rate, out_mp3, pitch="+0Hz"):
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    words = []
    with open(out_mp3, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                s = chunk["offset"] / 1e7
                words.append({"word": chunk["text"], "start": round(s, 3), "end": round(s + chunk["duration"] / 1e7, 3)})
    return words


def google(text, voice, rate, out_mp3, pitch="+0Hz"):
    key = os.environ.get("GOOGLE_TTS_API_KEY", "")
    if not key:
        sys.exit("GOOGLE_TTS_API_KEY is not set")
    tokens = text.split()
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    ssml = "<speak>" + " ".join(f'<mark name="w{i}"/>{esc(t)}' for i, t in enumerate(tokens)) + "</speak>"
    pct = int(re.sub(r"[^\d-]", "", rate) or 0)
    semis = float(re.sub(r"[^\d.-]", "", pitch) or 0) / 8.0   # rough Hz -> semitones
    body = {
        "input": {"ssml": ssml},
        "voice": {"languageCode": "-".join(voice.split("-")[:2]), "name": voice},
        "audioConfig": {"audioEncoding": "MP3", "speakingRate": 1 + pct / 100, "pitch": semis, "sampleRateHertz": 44100},
        "enableTimePointing": ["SSML_MARK"],
    }
    req = urllib.request.Request(
        f"https://texttospeech.googleapis.com/v1beta1/text:synthesize?key={key}",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    res = json.load(urllib.request.urlopen(req, timeout=120))
    with open(out_mp3, "wb") as f:
        f.write(base64.b64decode(res["audioContent"]))
    marks = {tp["markName"]: tp["timeSeconds"] for tp in res.get("timepoints", [])}
    words = []
    for i, t in enumerate(tokens):
        s = marks.get(f"w{i}")
        if s is None:
            continue
        nxt = marks.get(f"w{i + 1}")
        words.append({"word": t, "start": round(s, 3), "end": round((nxt if nxt else s + 0.4) - 0.03, 3)})
    return words


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out or 0)


def segments(segs, engine, voice, out_mp3):
    tmp = tempfile.mkdtemp(prefix="tts_")
    files, words, t = [], [], 0.0
    for i, s in enumerate(segs):
        part = os.path.join(tmp, f"seg_{i:03d}.mp3")
        rate, pitch = s.get("rate", "+0%"), s.get("pitch", "+0Hz")
        w = asyncio.run(edge(s["text"], voice, rate, part, pitch)) if engine == "edge" else google(s["text"], voice, rate, part, pitch)
        # trim the leading/trailing silence each clip carries so the delivery stays tight
        lead = max(0.0, (w[0]["start"] if w else 0) - 0.04)
        trimmed = os.path.join(tmp, f"seg_{i:03d}.wav")
        end = (w[-1]["end"] + 0.12) if w else duration(part)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", part, "-ss", f"{lead:.3f}", "-to", f"{end:.3f}",
                        "-ar", "24000", "-ac", "1", trimmed], check=True)
        d = duration(trimmed)
        for x in w:
            words.append({"word": x["word"], "start": round(t + x["start"] - lead, 3), "end": round(t + x["end"] - lead, 3), "seg": i})
        files.append(trimmed)
        gap = float(s.get("gap", 0.08))
        if gap > 0:
            sil = os.path.join(tmp, f"gap_{i:03d}.wav")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", f"{gap:.3f}", sil], check=True)
            files.append(sil)
        t += d + max(0.0, gap)
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as f:
        f.write("\n".join(f"file '{p.replace(os.sep, '/')}'" for p in files))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c:a", "libmp3lame", "-b:a", "128k", out_mp3], check=True)
    return words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("text_file", nargs="?"); ap.add_argument("out_mp3"); ap.add_argument("out_json")
    ap.add_argument("--engine", default="edge"); ap.add_argument("--voice", required=True); ap.add_argument("--rate", default="+0%")
    ap.add_argument("--segments", default="")
    a = ap.parse_args()
    if a.segments:
        words = segments(json.load(open(a.segments, encoding="utf-8")), a.engine, a.voice, a.out_mp3)
    else:
        text = open(a.text_file, encoding="utf-8").read().strip()
        words = asyncio.run(edge(text, a.voice, a.rate, a.out_mp3)) if a.engine == "edge" else google(text, a.voice, a.rate, a.out_mp3)
    if not words:
        sys.exit("no word timings returned")
    json.dump(words, open(a.out_json, "w", encoding="utf-8"), indent=0)
    print(f"{len(words)} words, {words[-1]['end']:.2f}s")


if __name__ == "__main__":
    main()
