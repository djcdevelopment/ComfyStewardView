#!/usr/bin/env python3
"""Verify an immutable world bundle, smoke-test a candidate, then replace only steward-world."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from archive import REPO,checked_file,digest,load,now,save
from deploy_gallery import remote


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',type=Path,required=True);parser.add_argument('--jar',type=Path,required=True)
    parser.add_argument('--revision',required=True);parser.add_argument('--ssh-target',default='am4')
    parser.add_argument('--remote-root',default='/home/derek/steward-world');parser.add_argument('--receipt',type=Path,required=True)
    args=parser.parse_args();root=args.bundle.resolve()
    if not re.fullmatch('[a-f0-9]{40}',args.revision):raise ValueError('Use a complete source commit')
    if not re.fullmatch('/home/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+',args.remote_root):raise ValueError('Invalid deployment root')
    if not re.fullmatch('[A-Za-z0-9_.@-]+',args.ssh_target):raise ValueError('Invalid SSH alias')
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    dirty=subprocess.check_output(['git','status','--porcelain','--','lab','viewer','tools/era-archive','tools/selfie-stick'],cwd=REPO,text=True)
    if head!=args.revision or dirty.strip():raise ValueError('Commit the reviewed implementation before release')
    receipt=load(root/'receipt.json')
    for file in receipt['files']:checked_file(root,file)
    with tempfile.TemporaryDirectory(prefix='steward-world-') as temporary:
        archive=Path(temporary)/'world.tgz'
        with tarfile.open(archive,'w:gz') as tar:
            for record in receipt['files']:tar.add(root/record['path'],arcname='catalog/'+record['path'],recursive=False)
            tar.add(root/'receipt.json',arcname='catalog/receipt.json',recursive=False)
            tar.add(args.jar,arcname='steward-spatial-lab.jar',recursive=False)
        stamp=digest(archive);release=args.revision[:12]+'-'+stamp['sha256'][:12]
        target='/tmp/steward-world-'+release+'.tgz'
        remote(args.ssh_target,'import subprocess\nsubprocess.run(["docker","inspect","-f","{{.State.Running}}","steward-world"],check=True,capture_output=True)\n')
        subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=10',str(archive),args.ssh_target+':'+target],check=True)
        settings={'root':args.remote_root,'archive':target,'release':release,'revision':args.revision,'sha256':stamp['sha256'],'bytes':stamp['bytes'],'jar':digest(args.jar)}
        result=json.loads(remote(args.ssh_target,'settings='+repr(settings)+'\n'+REMOTE))
        save(args.receipt,{'schema':'steward-world-deployment/v1','deployedAt':now(),'revision':args.revision,'archive':stamp,'jar':settings['jar'],'remote':result})
        print(json.dumps(result))


REMOTE=r'''
import hashlib,json,os,socket,subprocess,tarfile,time,urllib.request,urllib.error
from pathlib import Path
def run(*args):return subprocess.check_output(args,text=True,stderr=subprocess.PIPE).strip()
root=Path(settings['root']);archive=Path(settings['archive'])
assert archive.stat().st_size==settings['bytes'] and hashlib.sha256(archive.read_bytes()).hexdigest()==settings['sha256']
dest=root/'releases'/settings['release'];assert not dest.exists();dest.mkdir(parents=True)
with tarfile.open(archive) as tar:
    for member in tar.getmembers():assert member.isfile() and (dest/member.name).resolve().is_relative_to(dest.resolve())
    tar.extractall(dest,filter='data')
jar=dest/'steward-spatial-lab.jar'
assert jar.stat().st_size==settings['jar']['bytes'] and hashlib.sha256(jar.read_bytes()).hexdigest()==settings['jar']['sha256']
for item in json.loads((dest/'catalog/receipt.json').read_text())['files']:
    file=dest/'catalog'/item['path'];assert file.resolve().is_relative_to((dest/'catalog').resolve())
    assert file.stat().st_size==item['bytes'] and hashlib.sha256(file.read_bytes()).hexdigest()==item['sha256']
old=json.loads(run('docker','inspect','steward-world'))[0]
base=old['Config']['Image'];assert base.startswith('steward-world:')
# Preserve the current server's environment without displaying credentials.
environment={line.split('=',1)[0]:line.split('=',1)[1] for line in old['Config']['Env']}
environment['STEWARD_RELEASE_VERSION']=settings['release'];environment['STEWARD_SOURCE_REVISION']=settings['revision']
envfile=dest/'runtime.env';envfile.write_text(''.join(k+'='+v+'\n' for k,v in environment.items()));envfile.chmod(0o600)
dockerfile=dest/'Dockerfile';dockerfile.write_text('FROM '+base+'\nCOPY steward-spatial-lab.jar /app/steward-spatial-lab.jar\n')
image='steward-world:'+settings['release'];run('docker','build','-q','-t',image,str(dest))
catalog=json.loads((dest/'catalog/catalog.json').read_text());default=next(e for e in catalog['eras'] if e['slug']==catalog['defaultEra'])
assert default['status']=='ready'
candidate='steward-world-candidate-'+settings['release']
with socket.socket() as probe:probe.bind(('127.0.0.1',7083))
def start(name,port):
    return run('docker','run','-d','--name',name,'--restart','unless-stopped','--read-only','--memory','3g','--cpus','2',
        '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,exec,nosuid,size=512m',
        '--env-file',str(envfile),'-v',str(dest/'catalog')+':/catalog:ro','-p','127.0.0.1:'+str(port)+':8091','--entrypoint','java',image,
        '-Xms256m','-Xmx1g','-Djava.awt.headless=true','-jar','/app/steward-spatial-lab.jar','serve','--public','--bind','0.0.0.0',
        '--port','8091','--cache','/catalog/'+default['cache'],'--artifacts','/catalog/'+default['artifacts'],
        '--context-manifest','/catalog/'+default['contextManifest'],'--era-catalog','/catalog/catalog.json',
        '--snapshot',str(default['snapshotId']),'--public-url',environment.get('PUBLIC_URL','https://am4.tail8e749c.ts.net/world/'),
        '--release-version',settings['release'],'--no-browser')
def get(port,path):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=10) as response:return json.load(response)
def healthy(port):
    for attempt in range(30):
        try:
            health=get(port,'/api/health')
            if health.get('status')=='ready':return health
        except (OSError,ValueError):pass
        time.sleep(1)
    raise RuntimeError('World candidate readiness timed out')
start(candidate,7083)
try:
    assert healthy(7083)['release']==settings['release']
    eras=get(7083,'/api/eras');assert len(eras['eras'])==len(catalog['eras'])
    bootstrap=get(7083,'/api/bootstrap');assert len(bootstrap['snapshots'])==1 and bootstrap['snapshots'][0]['snapshotId']==default['snapshotId']
    for pending in [e for e in catalog['eras'] if e['status']!='ready']:
        try:get(7083,'/api/bootstrap?era='+pending['slug']);raise AssertionError('Pending era fell through')
        except urllib.error.HTTPError as error:assert error.code==503
    try:get(7083,'/api/manifest?era='+default['slug']+'&snapshot=999999');raise AssertionError('Cross-snapshot request admitted')
    except urllib.error.HTTPError as error:assert error.code==400
finally:run('docker','rm','-f',candidate)
backup='steward-world-before-'+settings['release']
run('docker','stop','steward-world');run('docker','rename','steward-world',backup)
try:
    container=start('steward-world',7081);healthy(7081)
    assert get(7081,'/api/eras')==eras
except Exception:
    subprocess.run(['docker','rm','-f','steward-world'],capture_output=True)
    run('docker','rename',backup,'steward-world');run('docker','start','steward-world');raise
result={'release':settings['release'],'directory':str(dest),'container':container,'previousContainer':backup,
        'baseImageId':old['Image'],'imageId':run('docker','image','inspect','-f','{{.Id}}',image),'eras':eras,
        'publicSnapshot':default['snapshotId'],'candidateVerified':True,'activeVerified':True,'port':7081}
(dest/'deployment.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
'''

if __name__=='__main__':main()
