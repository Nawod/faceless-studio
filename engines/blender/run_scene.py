"""Blender entry: build <workspace>/blender/scene.py with bkit importable, save scene.blend.
blender -b --python-exit-code 1 -P run_scene.py -- <workspace>/blender
"""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
bdir = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
os.chdir(bdir)
os.environ.setdefault('BKIT_SPEC', os.path.join(bdir, 'spec.json'))
os.environ.setdefault('BKIT_OUT', os.path.join(bdir, 'scene.blend'))
sys.path.insert(0, bdir)
runpy.run_path(os.path.join(bdir, 'scene.py'), run_name='__main__')
