#!/usr/bin/env python3
"""Stage verified original archive pairs over SSH without touching a running game."""
import argparse
import base64
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import time

from capture_worker import read, stamp, verify, write


# The same verifier runs on AM4; archive members are streamed to fixed paths,
# never extracted by their supplied paths. A complete pair is published atomically.
REMOTE = r'''
import hashlib,json,os,pathlib,shutil,tarfile,uuid
def stamp(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(4*1024*1024),b''): h.update(block)
 return {'bytes':path.stat().st_size,'sha256':h.hexdigest()}
def verify(path,spec):
 assert stamp(path)=={k:spec[k] for k in ('bytes','sha256')}, 'File mismatch: '+str(path)
root=pathlib.Path(settings['root']).resolve()
root.mkdir(parents=True,exist_ok=True)
era=settings['era']; final=root/(era['slug']+'-'+era['sourceKey'])
assert not final.is_symlink() and final.resolve().parent==root
files={k:era[k] for k in ('db','fwl')}
receipt={'schema':'steward-staged-world/v1','era':era['slug'],'sourceKey':era['sourceKey'],
         'worldId':era['worldId'],'directory':str(final),'files':files}
if final.exists():
 for spec in files.values(): verify(final/spec['name'],spec)
 print(json.dumps({**receipt,'status':'verified-existing'}))
elif settings['operation']=='probe':
 required=sum(s['bytes'] for s in files.values())*2+20*1024**3
 assert shutil.disk_usage(root).free>=required, 'Insufficient disk reserve for staging'
 print(json.dumps({'status':'missing'}))
else:
 archive=root/settings['package']['name']
 assert archive.resolve().parent==root and not archive.is_symlink()
 verify(archive,settings['package'])
 assert shutil.disk_usage(root).free>=sum(s['bytes'] for s in files.values())+20*1024**3, 'Disk reserve'
 temporary=root/('.incoming-'+era['slug']+'-'+uuid.uuid4().hex)
 temporary.mkdir()
 with tarfile.open(archive,'r:gz') as bundle:
  members=bundle.getmembers()
  assert len(members)==2 and {m.name for m in members}=={s['name'] for s in files.values()}, 'Unexpected archive members'
  for spec in files.values():
   member=bundle.getmember(spec['name'])
   assert member.isfile() and member.size==spec['bytes'], 'Unexpected archive entry'
   target=temporary/spec['name']
   assert target.resolve().parent==temporary.resolve()
   with bundle.extractfile(member) as source,target.open('xb') as destination:
    shutil.copyfileobj(source,destination,4*1024*1024)
    destination.flush();os.fsync(destination.fileno())
   verify(target,spec);target.chmod(0o444)
 (temporary/'receipt.json').write_text(json.dumps({**receipt,'status':'verified'},indent=2)+'\n')
 temporary.rename(final)
 # Only the uploaded, verified transport duplicate is removed. Originals remain.
 archive.unlink()
 print(json.dumps({**receipt,'status':'verified'}))
'''


def remote(target, settings):
    script='settings='+repr(settings)+'\n'+REMOTE
    encoded=base64.b64encode(script.encode()).decode('ascii')
    result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8',target,
                           'echo '+encoded+' | base64 -d | python3'],check=True,capture_output=True,text=True)
    return json.loads(result.stdout)


def source_spec(era):
    if not re.fullmatch(r'era\d+',era['slug']) or not re.fullmatch(r'[a-f0-9]{64}',era['sourceKey']):
        raise ValueError('Invalid era identity')
    result={k:era[k] for k in ('slug','sourceKey','worldId')}
    for kind in ('db','fwl'):
        source=Path(era[kind]['path'])
        if not re.fullmatch(r'[A-Za-z0-9_. -]+',source.name):raise ValueError('Unsafe save name')
        result[kind]={**{k:era[kind][k] for k in ('bytes','sha256')},'name':source.name}
    return result


def stage(args):
    if not re.fullmatch(r'[a-f0-9]{40}',args.revision):raise ValueError('Expected immutable source revision')
    if not re.fullmatch(r'[A-Za-z0-9_.@-]+',args.ssh_target):raise ValueError('Invalid SSH target')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+',args.remote_root) or '..' in PurePosixPath(args.remote_root).parts:
        raise ValueError('Unsafe remote root')
    catalog=read(args.catalog); available={e['slug']:e for e in catalog['eras']}
    if len(args.eras)!=len(set(args.eras)) or any(e not in available for e in args.eras):
        raise ValueError('Unknown or repeated era')
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    status={'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'state':'starting',
            'target':args.ssh_target,'remoteRoot':args.remote_root,'requested':args.eras,
            'sourceRevision':args.revision,'completed':[]}
    def report(state, **extra):
        status.update(state=state,**extra);write(output/'status.json',status)
        print(json.dumps({'state':state,**extra}),flush=True)
    try:
        for slug in args.eras:
            era=available[slug];spec=source_spec(era)
            settings={'root':args.remote_root,'era':spec,'operation':'probe'}
            report('checking',era=slug)
            result=remote(args.ssh_target,settings)
            if result['status']!='verified-existing':
                report('compressing',era=slug)
                package=output/(slug+'-'+era['sourceKey']+'.tgz')
                temporary=package.with_suffix('.tgz.partial')
                with tarfile.open(temporary,'w:gz',compresslevel=1) as bundle:
                    for kind in ('db','fwl'):
                        source=Path(era[kind]['path']);verify(source,era[kind])
                        bundle.add(source,arcname=spec[kind]['name'],recursive=False)
                temporary.replace(package)
                transport={**stamp(package),'name':package.name}
                write(output/(slug+'-transport.json'),transport)
                report('transferring',era=slug,packageBytes=transport['bytes'])
                subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=8',str(package),
                                args.ssh_target+':'+args.remote_root+'/'+package.name],check=True)
                report('verifying',era=slug)
                result=remote(args.ssh_target,{**settings,'operation':'install','package':transport})
            write(output/(slug+'-receipt.json'),result)
            status['completed'].append(result)
            report('verified',era=slug,completedEras=len(status['completed']))
        report('complete',completedEras=len(status['completed']))
    except Exception as error:
        report('failed',error=str(error));raise
    return status


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--eras',nargs='+',required=True)
    parser.add_argument('--ssh-target',required=True)
    parser.add_argument('--remote-root',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--revision',required=True)
    stage(parser.parse_args())
