#!/usr/bin/env python3
"""Add one verified era by hard-link cloning the live world catalog."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

from archive import REPO, checked_file, digest, load, now, save
from deploy_gallery import remote
from deploy_world_code import validate_thin_jar


def validate_package(root):
    root=Path(root).resolve();receipt=load(root/'receipt.json');entry=load(root/'entry.json')
    if receipt.get('schema')!='steward-world-era-package/v1' or receipt.get('entry')!=entry:
        raise ValueError('Invalid incremental era package receipt')
    slug=receipt.get('era')
    if not re.fullmatch(r'era[0-9]+',str(slug)) or entry.get('slug')!=slug:
        raise ValueError('Invalid incremental era slug')
    if entry.get('status')!='ready' or entry.get('snapshotId')!=receipt.get('snapshotId'):
        raise ValueError('Incremental era is not ready')
    files=receipt.get('files') or []
    if not files:raise ValueError('Incremental era package is empty')
    for item in files:
        path=Path(str(item.get('path','')))
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0]!=slug:
            raise ValueError(f'Unsafe incremental era path: {path}')
        checked_file(root,item)
    if sorted(files,key=lambda item:item['path'])!=sorted(entry.get('files') or [],key=lambda item:item['path']):
        raise ValueError('Incremental era entry/file receipt mismatch')
    expected={Path(item['path']) for item in files}
    actual={path.relative_to(root) for path in (root/slug).rglob('*') if path.is_file()}
    if actual!=expected:raise ValueError('Incremental era package file set drift')
    required={Path(entry['cache']),Path(entry['artifacts'])/str(entry['snapshotId'])/'manifest.json'}
    if entry.get('contextManifest'):required.add(Path(entry['contextManifest']))
    if not required.issubset(actual):raise ValueError('Incremental era package lacks a declared runtime input')
    return receipt,entry


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package',type=Path,required=True)
    parser.add_argument('--jar',type=Path,required=True,
                        help="Maven's target/original-steward-spatial-lab-*.jar")
    parser.add_argument('--revision',required=True)
    parser.add_argument('--ssh-target',default='am4')
    parser.add_argument('--remote-root',default='/home/derek/steward-world')
    parser.add_argument('--receipt',type=Path,required=True)
    args=parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}',args.revision):raise ValueError('Use a complete source commit')
    if not re.fullmatch(r'/home/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+',args.remote_root):raise ValueError('Invalid deployment root')
    if not re.fullmatch(r'[A-Za-z0-9_.@-]+',args.ssh_target):raise ValueError('Invalid SSH alias')
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    dirty=subprocess.check_output(['git','status','--porcelain','--','lab','tools/era-archive'],cwd=REPO,text=True)
    if head!=args.revision or dirty.strip():raise ValueError('Commit the reviewed era implementation before release')
    package,entry=validate_package(args.package);jar=validate_thin_jar(args.jar)
    root=args.package.resolve()
    with tempfile.TemporaryDirectory(prefix='steward-era-') as temporary:
        archive=Path(temporary)/'era.tgz'
        with tarfile.open(archive,'w:gz') as tar:
            tar.add(jar,arcname='steward-code.jar',recursive=False)
            tar.add(root/'entry.json',arcname='entry.json',recursive=False)
            for item in package['files']:
                tar.add(root/item['path'],arcname=item['path'],recursive=False)
        archive_stamp=digest(archive)
        release=(args.revision[:12]+'-add-'+entry['slug']+'-'+archive_stamp['sha256'][:12])
        target='/tmp/steward-world-'+release+'.tgz'
        remote(args.ssh_target,'import subprocess\nsubprocess.run(["docker","inspect","-f",'
               '"{{.State.Running}}","steward-world"],check=True,capture_output=True)\n')
        subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=10',str(archive),
                        args.ssh_target+':'+target],check=True)
        settings={'root':args.remote_root,'archive':target,'release':release,'revision':args.revision,
                  'sha256':archive_stamp['sha256'],'bytes':archive_stamp['bytes'],'jar':digest(jar),
                  'entry':entry,'files':{item['path']:item for item in package['files']}}
        result=json.loads(remote(args.ssh_target,'settings='+repr(settings)+'\n'+REMOTE))
        save(args.receipt,{'schema':'steward-world-era-deployment/v1','deployedAt':now(),
                           'revision':args.revision,'era':entry['slug'],'snapshotId':entry['snapshotId'],
                           'archive':archive_stamp,'remote':result})
        print(json.dumps(result))


REMOTE=r'''
import datetime,hashlib,json,os,shutil,socket,subprocess,tarfile,time,urllib.request
from pathlib import Path

def run(*args):return subprocess.check_output(args,text=True,stderr=subprocess.PIPE).strip()
def stamp(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(8*1024*1024),b''):value.update(block)
    return {'bytes':path.stat().st_size,'sha256':value.hexdigest()}
def write_json(path,value):
    candidate=path.with_name(path.name+'.era-new')
    candidate.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    os.replace(candidate,path)

root=Path(settings['root']).resolve();incoming=Path(settings['archive'])
assert root==Path('/home')/root.parts[2]/root.parts[3]
assert stamp(incoming)=={'bytes':settings['bytes'],'sha256':settings['sha256']}
old=json.loads(run('docker','inspect','steward-world'))[0];assert old['State']['Running'] is True
base=old['Config']['Image'];assert base.startswith('steward-world:');run('docker','image','inspect',base)
mounts={mount['Destination']:mount for mount in old['Mounts']}
source_catalog=Path(mounts['/catalog']['Source']).resolve();requests_dir=Path(mounts['/requests']['Source']).resolve()
releases=(root/'releases').resolve()
assert source_catalog.is_dir() and source_catalog.is_relative_to(releases)
assert mounts['/catalog']['RW'] is False and (source_catalog/'catalog.json').is_file()
assert requests_dir==(root/'shot-requests').resolve() and requests_dir.is_dir()

dest=releases/settings['release'];assert not dest.exists();dest.mkdir(parents=True)
staging=dest/'incoming';staging.mkdir()
with tarfile.open(incoming) as tar:
    members=tar.getmembers()
    for member in members:
        assert member.isfile() and (staging/member.name).resolve().is_relative_to(staging.resolve())
    tar.extractall(staging,filter='data')
incoming.unlink()
expected={'steward-code.jar','entry.json'}|set(settings['files'])
assert {path.relative_to(staging).as_posix() for path in staging.rglob('*') if path.is_file()}==expected
for name,record in settings['files'].items():assert stamp(staging/name)=={'bytes':record['bytes'],'sha256':record['sha256']}
entry=json.loads((staging/'entry.json').read_text(encoding='utf-8'));assert entry==settings['entry']
code_jar=dest/'steward-code.jar';os.replace(staging/'steward-code.jar',code_jar)
assert stamp(code_jar)==settings['jar'];code_jar.chmod(0o444)

catalog=dest/'catalog';shutil.copytree(source_catalog,catalog,copy_function=os.link)
slug=entry['slug'];prefix=slug+'/'
catalog_document=json.loads((catalog/'catalog.json').read_text(encoding='utf-8'))
existing=[item for item in catalog_document['eras'] if item['slug']==slug]
assert len(existing)<=1
if existing:
    assert existing[0]['status']!='ready' and existing[0]['snapshotId']==entry['snapshotId']
    catalog_document['eras'].remove(existing[0])
era_dir=catalog/slug;assert not era_dir.exists();os.replace(staging/slug,era_dir)
for path in era_dir.rglob('*'):
    if path.is_file():path.chmod(0o444)
for record in entry['files']:
    path=catalog/record['path'];assert path.resolve().is_relative_to(catalog.resolve())
    assert stamp(path)=={'bytes':record['bytes'],'sha256':record['sha256']}
catalog_document['eras'].append(entry)
catalog_document['eras'].sort(key=lambda item:int(item['slug'][3:]))
created=datetime.datetime.now(datetime.timezone.utc).isoformat();catalog_document['createdAt']=created
write_json(catalog/'catalog.json',catalog_document)
receipt_path=catalog/'receipt.json';receipt=json.loads(receipt_path.read_text(encoding='utf-8'))
receipt['createdAt']=created
receipt['files']=[item for item in receipt['files'] if item['path']!='catalog.json' and not item['path'].startswith(prefix)]
receipt['files'].append({'path':'catalog.json',**stamp(catalog/'catalog.json')})
receipt['files']+=entry['files'];receipt['files'].sort(key=lambda item:item['path']);write_json(receipt_path,receipt)
(catalog/'catalog.json').chmod(0o444);receipt_path.chmod(0o444)
(staging/'entry.json').unlink();staging.rmdir()

environment={line.split('=',1)[0]:line.split('=',1)[1] for line in old['Config']['Env']}
environment['STEWARD_RELEASE_VERSION']=settings['release'];environment['STEWARD_SOURCE_REVISION']=settings['revision']
envfile=dest/'runtime.env';envfile.write_text(''.join(key+'='+value+'\n' for key,value in environment.items()));envfile.chmod(0o600)
ui=dest/'ui';ui.mkdir();command=list(old['Config']['Cmd']);main='dev.steward.lab.LabMain'
if '-jar' in command:
    marker=command.index('-jar');jvm=command[:marker];application=command[marker+2:]
else:
    marker=command.index('-cp');main_index=command.index(main);assert marker<main_index
    jvm=command[:marker];application=command[main_index+1:]
assert application and application[0]=='serve'
release_flag=application.index('--release-version');application[release_flag+1]=settings['release']
command=jvm+['-cp','/app/steward-code.jar:/app/steward-spatial-lab.jar',main]+application

with socket.socket() as probe:probe.bind(('127.0.0.1',7083))
def start(name,port):
    return run('docker','run','-d','--name',name,'--restart','unless-stopped','--read-only',
        '--memory','3g','--cpus','2','--cap-drop','ALL','--security-opt','no-new-privileges:true',
        '--tmpfs','/tmp:rw,exec,nosuid,size=512m','--env-file',str(envfile),
        '-v',str(catalog)+':/catalog:ro','-v',str(ui)+':/ui:ro','-v',str(requests_dir)+':/requests:rw',
        '-v',str(code_jar)+':/app/steward-code.jar:ro','-p','127.0.0.1:'+str(port)+':8091',
        '--entrypoint','java',base,*command)
def get(port,path):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=15) as response:return json.load(response)
def text(port,path):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=15) as response:return response.read().decode('utf-8')
def healthy(port):
    for attempt in range(45):
        try:
            health=get(port,'/api/health')
            if health.get('status')=='ready':return health
        except (OSError,ValueError):pass
        time.sleep(1)
    raise RuntimeError('World candidate readiness timed out')
def verify(port):
    health=healthy(port);assert health['release']==settings['release']
    eras=get(port,'/api/eras');assert len(eras['eras'])==len(catalog_document['eras'])
    selected=get(port,'/api/bootstrap?era='+slug)
    assert len(selected['snapshots'])==1 and selected['snapshots'][0]['snapshotId']==entry['snapshotId']
    assert selected['sceneAvailable'] and selected['terrainAvailable']==bool(entry.get('contextManifest'))
    if entry.get('contextManifest'):
        assert selected['context']['heightfieldAvailable'] is True
    page=text(port,'/scene.html');assert 'data-terrain="ghost"' in page and 'Ghost preserves underground rooms' in page
    return eras

candidate='steward-world-candidate-'+settings['release'];start(candidate,7083)
try:eras=verify(7083)
finally:run('docker','rm','-f',candidate)
backup='steward-world-before-'+settings['release'];run('docker','stop','steward-world');run('docker','rename','steward-world',backup)
try:
    container=start('steward-world',7081);verify(7081)
except Exception:
    subprocess.run(['docker','rm','-f','steward-world'],capture_output=True)
    run('docker','rename',backup,'steward-world');run('docker','start','steward-world');raise
result={'release':settings['release'],'directory':str(dest),'container':container,
    'previousContainer':backup,'baseImage':base,'catalog':str(catalog),'eras':eras,
    'candidateVerified':True,'activeVerified':True,'port':7081,'uiOverride':str(ui),
    'transferredBytes':settings['bytes'],'catalogTransferred':False,'catalogClonedWithHardlinks':True,
    'imageBuilt':False,'addedEra':slug,'addedSnapshot':entry['snapshotId']}
(dest/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
'''


if __name__=='__main__':main()
