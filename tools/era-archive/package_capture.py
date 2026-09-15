#!/usr/bin/env python3
"""Prepare a capture deployment from explicit catalog, runner and measured proof files."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
from urllib.parse import urlparse
from urllib.request import urlopen


def record(path):
    with path.open('rb') as stream:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def checked_child(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Proof asset escaped its root')
    return path


def build(catalog_path, release_path, runner_path, proofs, output):
    catalog, release = read(catalog_path), read(release_path)
    if catalog.get('schema') != 'steward-capture-catalog/v1' or release.get('schema') != 'selfiestick-runner-release/v1':
        raise ValueError('Unsupported capture inputs')
    if record(runner_path) != {key: release['package'][key] for key in ('bytes', 'sha256')}:
        raise ValueError('Runner artifact mismatch')
    output.mkdir(parents=True, exist_ok=False)
    shutil.copy2(runner_path, output / 'runner.zip')
    release['package']['path'] = 'runner.zip'
    (output / 'runner-release.json').write_text(json.dumps(release, indent=2)+'\n', encoding='utf-8')
    (output / 'thumbnails').mkdir()
    def thumbnail(photo):
        # Only existing hosted derivatives; no local source photographs or game data.
        url = photo['images']['thumbnail']
        if urlparse(url).scheme != 'https' or not photo['id'].replace('-', '').replace('_', '').isalnum():
            raise ValueError('Invalid hosted reference')
        with urlopen(url, timeout=30) as response:
            data = response.read(2*1024*1024+1)
        if len(data)>2*1024*1024 or data[:4]!=b'RIFF' or data[8:12]!=b'WEBP':
            raise ValueError('Invalid reference WebP')
        name='thumbnails/'+photo['id']+'.webp';path=output/name;path.write_bytes(data)
        photo['thumbnailAsset']={'path':name,**record(path)}
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(thumbnail, catalog['photos']))
    combined = {'schema': 'selfiestick-capture-proof/v1', 'error': None, 'hosts': {}}
    for proof_path in proofs:
        proof=read(proof_path)
        if proof.get('schema')!='selfiestick-capture-proof/v1' or proof.get('error'):
            raise ValueError('Capture proof failed')
        for host, cases in proof['hosts'].items():
            if host not in ('OMEN','AM4') or host in combined['hosts']:
                raise ValueError('Unexpected or duplicate proof host')
            target=output/'proof'/host;target.mkdir(parents=True)
            for case in cases:
                path=checked_child(proof_path.parent, case['receipt'])
                if record(path)['sha256']!=case['receiptSha256']:
                    raise ValueError('Proof receipt mismatch')
                receipt=read(path);image=checked_child(path.parent,receipt['png']['file'])
                if record(image)!={key:receipt['png'][key] for key in ('bytes','sha256')}:
                    raise ValueError('Proof PNG mismatch')
                dest=target/receipt['png']['file'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(image,dest)
                shutil.copy2(path,target/path.name);case['receipt']=f'proof/{host}/{path.name}'
            combined['hosts'][host]=cases
    catalog['downloadsEnabled']=False  # The Java server validates the complete proof itself.
    for name,value in [('catalog.json',catalog),('capture-proof.json',combined)]:
        (output/name).write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
    manifest={'schema':'steward-capture-deployment/v1','candidate':True,
              'files':[{'path':p.relative_to(output).as_posix(),**record(p)} for p in sorted(output.rglob('*')) if p.is_file()]}
    (output/'deployment-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(f"Prepared {len(catalog['photos'])} photographs and {len(combined['hosts'])} measured hosts in {output}")


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('catalog','runner-release','runner','out'):p.add_argument('--'+key,type=Path,required=True)
    p.add_argument('--proof',type=Path,action='append',default=[])
    args=p.parse_args();build(args.catalog,args.runner_release,args.runner,args.proof,args.out)
