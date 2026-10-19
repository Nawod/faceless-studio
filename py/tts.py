"""Narration with word-level timings.

usage: python tts.py <text_file> <out_mp3> <out_json> --engine edge|google --voice NAME [--rate +6%]
Writes the audio and a JSON list of {"word", "start", "end"} in seconds.
edge:   Microsoft Edge neural voices via edge-tts (free).
google: Google Cloud TTS (GOOGLE_TTS_API_KEY env), SSML <mark> per word for timings.
"""
import argparse, asyncio, base64, json, os, re, sys, urllib.request


async def edge(text, voice, rate, out_mp3):
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    words = []
    with open(out_mp3, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                s = chunk["offset"] / 1e7
                words.append({"word": chunk["text"], "start": round(s, 3), "end": round(s + chunk["duration"] / 1e7, 3)})
    return words


def google(text, voice, rate, out_mp3):
    key = os.environ.get("GOOGLE_TTS_API_KEY", "")
    if not key:
        sys.exit("GOOGLE_TTS_API_KEY is not set")
    tokens = text.split()
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    ssml = "<speak>" + " ".join(f'<mark name="w{i}"/>{esc(t)}' for i, t in enumerate(tokens)) + "</speak>"
    pct = int(re.sub(r"[^\d-]", "", rate) or 0)
    body = {
        "input": {"ssml": ssml},
        "voice": {"languageCode": "-".join(voice.split("-")[:2]), "name": voice},
        "audioConfig": {"audioEncoding": "MP3", "speakingRate": 1 + pct / 100, "sampleRateHertz": 44100},
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("text_file"); ap.add_argument("out_mp3"); ap.add_argument("out_json")
    ap.add_argument("--engine", default="edge"); ap.add_argument("--voice", required=True); ap.add_argument("--rate", default="+0%")
    a = ap.parse_args()
    text = open(a.text_file, encoding="utf-8").read().strip()
    words = asyncio.run(edge(text, a.voice, a.rate, a.out_mp3)) if a.engine == "edge" else google(text, a.voice, a.rate, a.out_mp3)
    if not words:
        sys.exit("no word timings returned")
    json.dump(words, open(a.out_json, "w", encoding="utf-8"), indent=0)
    print(f"{len(words)} words, {words[-1]['end']:.2f}s")


if __name__ == "__main__":
    main()
