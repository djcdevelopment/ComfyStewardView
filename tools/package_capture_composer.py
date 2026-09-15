#!/usr/bin/env python3
"""Package the shared photography UI for pinned Studio consumption."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT=Path(__file__).resolve().parents[1]
FILES=['capture-composer.js','capture-composer.css','camera-model.js','creator-scene.js','camera-fixtures.json']


def build(out):
    source=ROOT/'lab/src/main/resources/static'
    files=[{'path':name,'bytes':(source/name).stat().st_size,'sha256':hashlib.sha256((source/name).read_bytes()).hexdigest()} for name in FILES]
    manifest={'schema':'comfy-steward-capture-composer-artifact/v1','version':'1.0.0-preview.3',
              'sourceRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'candidate':True,'files':files}
    out.parent.mkdir(parents=True,exist_ok=True)
    if out.exists():raise ValueError('Use a new immutable artifact path')
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for name in FILES:z.write(source/name,name)
        z.writestr('manifest.json',json.dumps(manifest,indent=2)+'\n')
    pin={'path':out.name,'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),**{k:manifest[k] for k in ('schema','version','sourceRevision','candidate')}}
    out.with_suffix('.json').write_text(json.dumps(pin,indent=2)+'\n',encoding='utf-8');return pin


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out',type=Path,required=True);args=p.parse_args();print(json.dumps(build(args.out),indent=2))
