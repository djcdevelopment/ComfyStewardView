#!/usr/bin/env python3
"""Deploy a verified creator projection beside existing galleries, with an atomic directory switch."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from archive import REPO,checked_file,digest,load,now,save


def remote(target,code):
    result=subprocess.run(['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=10',target,'python3','-'],
        input=code,text=True,capture_output=True)
    if result.returncode:raise RuntimeError(f'Remote operation failed ({result.returncode}): {result.stderr.strip()}')
    return result.stdout


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--projection',type=Path,required=True);parser.add_argument('--revision',required=True)
    parser.add_argument('--ssh-target',default='fx99');parser.add_argument('--remote-root',default='/srv/sites/valheim')
    parser.add_argument('--receipt',type=Path,required=True)
    args=parser.parse_args();root=args.projection.resolve()
    if not re.fullmatch('[a-f0-9]{40}',args.revision):raise ValueError('Use a complete source commit')
    if not re.fullmatch('/srv/sites/[A-Za-z0-9_-]+',args.remote_root):raise ValueError('Expected a single gallery site root')
    if not re.fullmatch('[A-Za-z0-9_.@-]+',args.ssh_target):raise ValueError('Invalid SSH alias')
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    dirty=subprocess.check_output(['git','status','--porcelain','--','tools/era-archive','tools/selfie-stick'],cwd=REPO,text=True)
    if head!=args.revision or dirty.strip():raise ValueError('Commit the reviewed implementation before release')
    receipt=load(root/'receipt.json')
    expected={f['path'] for f in receipt['files']}|{'receipt.json'}
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual!=expected:raise ValueError('Projection file set drift')
    for file in receipt['files']:checked_file(root,file)
    with tempfile.TemporaryDirectory(prefix='steward-creators-') as temporary:
        archive=Path(temporary)/'creators.tgz'
        with tarfile.open(archive,'w:gz') as tar:
            for name in sorted(expected):tar.add(root/name,arcname=name,recursive=False)
        stamp=digest(archive);release=args.revision[:12]+'-'+stamp['sha256'][:12]
        remote_archive='/tmp/steward-creators-'+release+'.tgz'
        remote(args.ssh_target,'from pathlib import Path\np=Path('+repr(args.remote_root)+')\nassert p.is_dir()\n')
        subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=10',str(archive),args.ssh_target+':'+remote_archive],check=True)
        settings={'root':args.remote_root,'archive':remote_archive,'release':release,'sha256':stamp['sha256'],'bytes':stamp['bytes']}
        code='settings='+repr(settings)+'\n'+REMOTE
        result=json.loads(remote(args.ssh_target,code))
        save(args.receipt,{'schema':'steward-creator-deployment/v1','deployedAt':now(),'revision':args.revision,'archive':stamp,'projection':digest(root/'receipt.json'),'remote':result})
        print(json.dumps(result))


REMOTE=r'''
import hashlib,json,os,tarfile
from pathlib import Path
root=Path(settings['root']);archive=Path(settings['archive'])
assert archive.stat().st_size==settings['bytes']
assert hashlib.sha256(archive.read_bytes()).hexdigest()==settings['sha256']
releases=root/'.creator-releases';releases.mkdir(exist_ok=True)
dest=releases/settings['release'];assert not dest.exists();dest.mkdir()
with tarfile.open(archive) as tar:
    for member in tar.getmembers():
        target=(dest/member.name).resolve()
        assert target.is_relative_to(dest.resolve()) and member.isfile()
    tar.extractall(dest,filter='data')
receipt=json.loads((dest/'receipt.json').read_text())
for record in receipt['files']:
    file=dest/record['path'];assert file.stat().st_size==record['bytes']
    assert hashlib.sha256(file.read_bytes()).hexdigest()==record['sha256']
link=root/'creators';previous=os.readlink(link) if link.is_symlink() else None
assert not link.exists() or link.is_symlink(),'Existing creator directory is not owned by this release lane'
assert previous is None or Path(previous).resolve().is_relative_to(releases.resolve()),'Existing creator link is outside this release lane'
stage=root/('.creators-'+settings['release']);stage.symlink_to(dest,target_is_directory=True);os.replace(stage,link)
# Insert navigation into existing pages, preserving their data, photo URLs and current markup.
changed=[]
for page in [root/'index.html',root/'era16/index.html']:
    if not page.exists():continue
    source=page.read_text();needle='Builders across eras'
    if needle not in source:
        assert '</header>' in source
        backup=dest/('previous-'+('era16' if page.parent.name=='era16' else 'root')+'.html')
        backup.write_text(source)
        new=source.replace('</header>','<a class="filt" href="/valheim/creators/">Builders across eras</a>\n</header>',1)
        candidate=page.with_suffix('.html.creators-tmp');candidate.write_text(new);os.replace(candidate,page);changed.append(str(page))
print(json.dumps({'release':settings['release'],'directory':str(dest),'previous':previous,'navigationUpdated':changed,'filesVerified':len(receipt['files'])}))
'''

if __name__=='__main__':main()
