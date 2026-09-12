#!/usr/bin/env python3
"""Deploy only the world application's thin JAR, reusing the live image and catalog."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import zipfile

from archive import REPO, digest, now, save
from deploy_gallery import remote


REQUIRED_ENTRIES = {
    "dev/steward/lab/LabMain.class",
    "static/scene.html",
    "static/scene.js",
}


def validate_thin_jar(path):
    path = Path(path).resolve()
    if not path.is_file():
        raise ValueError(f"Thin application JAR not found: {path}")
    size = path.stat().st_size
    if size < 50_000 or size > 5_000_000:
        raise ValueError("Expected the thin application JAR (50 KB-5 MB), not the shaded runtime JAR")
    with zipfile.ZipFile(path) as archive:
        missing = REQUIRED_ENTRIES.difference(archive.namelist())
    if missing:
        raise ValueError(f"Thin application JAR is missing: {', '.join(sorted(missing))}")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, required=True,
                        help="Maven's target/original-steward-spatial-lab-*.jar")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--ssh-target", default="am4")
    parser.add_argument("--remote-root", default="/home/derek/steward-world")
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch("[a-f0-9]{40}", args.revision):
        raise ValueError("Use a complete source commit")
    if not re.fullmatch("/home/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+", args.remote_root):
        raise ValueError("Invalid deployment root")
    if not re.fullmatch("[A-Za-z0-9_.@-]+", args.ssh_target):
        raise ValueError("Invalid SSH alias")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    dirty = subprocess.check_output(
        ["git", "status", "--porcelain", "--", "lab"], cwd=REPO, text=True)
    if head != args.revision or dirty.strip():
        raise ValueError("Commit the reviewed lab implementation before release")

    jar = validate_thin_jar(args.jar)
    jar_stamp = digest(jar)
    release = args.revision[:12] + "-code-" + jar_stamp["sha256"][:12]
    target = "/tmp/steward-world-" + release + ".jar"
    remote(args.ssh_target,
           'import subprocess\nsubprocess.run(["docker","inspect","-f","{{.State.Running}}",'
           '"steward-world"],check=True,capture_output=True)\n')
    subprocess.run([
        "scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        str(jar), args.ssh_target + ":" + target,
    ], check=True)
    settings = {
        "root": args.remote_root,
        "jar": target,
        "release": release,
        "revision": args.revision,
        "sha256": jar_stamp["sha256"],
        "bytes": jar_stamp["bytes"],
    }
    result = json.loads(remote(args.ssh_target, "settings=" + repr(settings) + "\n" + REMOTE))
    save(args.receipt, {
        "schema": "steward-world-code-deployment/v1",
        "deployedAt": now(),
        "revision": args.revision,
        "applicationJar": jar_stamp,
        "remote": result,
    })
    print(json.dumps(result))


REMOTE = r'''
import hashlib,json,os,shutil,socket,subprocess,time,urllib.request
from pathlib import Path

def run(*args):
    return subprocess.check_output(args,text=True,stderr=subprocess.PIPE).strip()

root=Path(settings['root']).resolve();incoming=Path(settings['jar'])
assert root==Path('/home')/root.parts[2]/root.parts[3]
assert incoming.stat().st_size==settings['bytes']
assert hashlib.sha256(incoming.read_bytes()).hexdigest()==settings['sha256']
old=json.loads(run('docker','inspect','steward-world'))[0]
assert old['State']['Running'] is True
base=old['Config']['Image'];assert base.startswith('steward-world:')
run('docker','image','inspect',base)

mounts={mount['Destination']:mount for mount in old['Mounts']}
catalog=Path(mounts['/catalog']['Source']).resolve()
requests_dir=Path(mounts['/requests']['Source']).resolve()
releases=(root/'releases').resolve()
assert catalog.is_dir() and catalog.is_relative_to(releases)
assert mounts['/catalog']['RW'] is False and (catalog/'catalog.json').is_file()
assert requests_dir==(root/'shot-requests').resolve() and requests_dir.is_dir()

dest=releases/settings['release'];assert not dest.exists();dest.mkdir(parents=True)
code_jar=dest/'steward-code.jar';shutil.copyfile(incoming,code_jar);incoming.unlink();code_jar.chmod(0o444)
assert code_jar.stat().st_size==settings['bytes']
assert hashlib.sha256(code_jar.read_bytes()).hexdigest()==settings['sha256']
ui=dest/'ui';ui.mkdir()

# Preserve credentials without printing them, and change only release provenance.
environment={line.split('=',1)[0]:line.split('=',1)[1] for line in old['Config']['Env']}
environment['STEWARD_RELEASE_VERSION']=settings['release']
environment['STEWARD_SOURCE_REVISION']=settings['revision']
envfile=dest/'runtime.env'
envfile.write_text(''.join(key+'='+value+'\n' for key,value in environment.items()))
envfile.chmod(0o600)

# Keep the exact live application arguments. The first code-only release replaces -jar with
# an overlay classpath; later ones replace the preceding overlay while retaining the baked fat JAR.
command=list(old['Config']['Cmd'])
main='dev.steward.lab.LabMain'
if '-jar' in command:
    marker=command.index('-jar');jvm=command[:marker];application=command[marker+2:]
else:
    marker=command.index('-cp');main_index=command.index(main)
    assert marker < main_index
    jvm=command[:marker];application=command[main_index+1:]
assert application and application[0]=='serve'
command=jvm+['-cp','/app/steward-code.jar:/app/steward-spatial-lab.jar',main]+application

with socket.socket() as probe:probe.bind(('127.0.0.1',7083))
def start(name,port):
    return run('docker','run','-d','--name',name,'--restart','unless-stopped','--read-only',
        '--memory','3g','--cpus','2','--cap-drop','ALL','--security-opt','no-new-privileges:true',
        '--tmpfs','/tmp:rw,exec,nosuid,size=512m','--env-file',str(envfile),
        '-v',str(catalog)+':/catalog:ro','-v',str(ui)+':/ui:ro',
        '-v',str(requests_dir)+':/requests:rw','-v',str(code_jar)+':/app/steward-code.jar:ro',
        '-p','127.0.0.1:'+str(port)+':8091','--entrypoint','java',base,*command)
def get(port,path):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=15) as response:
        return json.load(response)
def text(port,path):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=15) as response:
        return response.read().decode('utf-8')
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
    eras=get(port,'/api/eras');catalog_json=json.loads((catalog/'catalog.json').read_text())
    assert len(eras['eras'])==len(catalog_json['eras'])
    for era in [item for item in catalog_json['eras'] if item['status']=='ready']:
        selected=get(port,'/api/bootstrap?era='+era['slug'])
        assert len(selected['snapshots'])==1 and selected['snapshots'][0]['snapshotId']==era['snapshotId']
        assert selected['sceneAvailable'] and selected['terrainAvailable']==bool(era.get('contextManifest'))
    scene_page=text(port,'/scene.html')
    assert 'Render primitives' in scene_page and 'Detail level' in scene_page and 'CAD shaded' in scene_page
    return eras

candidate='steward-world-candidate-'+settings['release']
start(candidate,7083)
try:eras=verify(7083)
finally:run('docker','rm','-f',candidate)

backup='steward-world-before-'+settings['release']
run('docker','stop','steward-world');run('docker','rename','steward-world',backup)
try:
    container=start('steward-world',7081);verify(7081)
except Exception:
    subprocess.run(['docker','rm','-f','steward-world'],capture_output=True)
    run('docker','rename',backup,'steward-world');run('docker','start','steward-world');raise

result={'release':settings['release'],'directory':str(dest),'container':container,
    'previousContainer':backup,'baseImage':base,'catalog':str(catalog),'eras':eras,
    'candidateVerified':True,'activeVerified':True,'port':7081,'uiOverride':str(ui),
    'transferredBytes':settings['bytes'],'catalogTransferred':False,'imageBuilt':False}
(dest/'deployment.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
'''


if __name__ == "__main__":
    main()
