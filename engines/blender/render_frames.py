"""Render frames of a saved scene.blend, resumable (every frame is independent).
blender -b scene.blend --python-exit-code 1 -P render_frames.py -- --frames 1-90,120 --out DIR [--scale 50] [--samples N] [--force]
Writes DIR/f_0001.jpg … and prints `FRAME n secs` per frame (the pipeline reads it for progress).
"""
import argparse
import os
import sys
import time

import bpy


def parse_frames(spec, last):
    out = []
    for part in (spec or f'1-{last}').split(','):
        part = part.strip()
        if '-' in part:
            a, b = part.split('-', 1)
            out.extend(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted({f for f in out if 1 <= f <= last})


argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--frames')
ap.add_argument('--out', required=True)
ap.add_argument('--scale', type=int, default=100)
ap.add_argument('--samples', type=int)
ap.add_argument('--force', action='store_true')
a = ap.parse_args(argv)

sc = bpy.context.scene
sc.render.resolution_percentage = a.scale
if a.samples:
    sc.eevee.taa_render_samples = a.samples
sc.render.image_settings.file_format = 'JPEG'
sc.render.image_settings.quality = 92
os.makedirs(a.out, exist_ok=True)
done = 0
t0 = time.time()
for f in parse_frames(a.frames, sc.frame_end):
    path = os.path.join(os.path.abspath(a.out), f'f_{f:04d}.jpg')
    if not a.force and os.path.isfile(path) and os.path.getsize(path) > 1000:
        continue
    t = time.time()
    sc.frame_set(f)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    done += 1
    print(f'FRAME {f} {time.time() - t:.2f}', flush=True)
print(f'RENDER_DONE {done} {time.time() - t0:.1f}', flush=True)
