#!/usr/bin/env python3
"""Project public capture metadata from existing gallery manifests and exact archive identity."""
import argparse
import json
import math
from pathlib import Path
import re


def vector(value):
    if isinstance(value,dict):value=[value.get(k) for k in 'xyz']
    if not isinstance(value,list) or len(value)!=3 or not all(type(v) in (int,float) and math.isfinite(v) for v in value):
        raise ValueError('Recorded lens position is unavailable.')
    return value


def project(manifests,archive):
    eras={e['slug']:e for e in archive['eras']}
    photos={}
    for manifest in manifests:
        if manifest.get('schema')!='steward-capture-gallery/v1':raise ValueError('unsupported capture gallery')
        era=eras.get(manifest['era'],{})
        matching=bool(era and era.get('sourceKey')==manifest.get('sourceKey'))
        world={'id':era.get('worldId') if matching else None,'era':manifest['era'],
               'archiveId':era.get('archiveWorldId') if matching else None}
        if matching:
            for key in ('db','fwl'):
                if era.get(key):world[key]={k:era[key].get(k) for k in ('bytes','sha256')}
        for build,album in manifest['builds'].items():
            for photo in album:
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,180}',photo['id']):raise ValueError('unsafe photograph id')
                pose=photo.get('pose') or {};capture=photo.get('capture') or {};reason=None;camera=None
                try:
                    lens=vector(pose.get('lens'))
                    for name in ('yaw','pitch','fov'):
                        if type(pose.get(name)) not in (int,float) or not math.isfinite(pose[name]):raise ValueError('Recorded camera orientation or field of view is unavailable.')
                    w,h=photo.get('width'),photo.get('height')
                    if not w or not h:raise ValueError('Original photograph dimensions are unavailable.')
                    ratio=w/h
                    frame=next((f for f in ((16,9),(1,1),(9,16)) if abs(f[0]/f[1]-ratio)<.002),None)
                    if frame is None:raise ValueError('This photograph uses a frame shape the composer does not yet support.')
                    width,height=[round(1920*v/max(frame)) for v in frame]
                    distance=capture.get('shot_distance_m') or math.dist(lens,vector(pose.get('aim')))
                    camera={'lens':lens,'yaw':pose['yaw'],'pitch':pose['pitch'],'roll':pose.get('roll',0),
                            'verticalFov':pose['fov'],'width':width,'height':height,'targetDistance':distance}
                except (ValueError,TypeError,ZeroDivisionError) as error:reason=str(error)
                settings={'environment':capture.get('environment'),'timeOfDay':capture.get('time_of_day'),
                          'fires':capture.get('fires'),'flashBearing':capture.get('flash_bearing_deg')}
                compose=camera is not None and matching and manifest.get('snapshotId') is not None
                replay=compose and all(world.get(k,{}).get('sha256') and world[k].get('bytes') for k in ('db','fwl'))
                replay=bool(replay and settings['environment'] and type(settings['timeOfDay']) in (int,float) and type(settings['fires']) is bool)
                reason=reason or ('Matching archive identity is unavailable.' if not matching else
                    'Recorded lighting settings or archive hashes are incomplete; local replay is unavailable.' if not replay else '')
                row={'id':photo['id'],'label':photo.get('label') or photo['id'],'buildLabel':manifest['era']+' · '+(photo.get('label') or build[:12]),
                     'source':{'photoId':photo['id'],'buildKey':build,'world':world,'photoSha256':photo.get('sha256')},
                     'images':{'thumbnail':photo['thumb'],'large':photo['large']},
                     'camera':camera,'settings':settings,'originalCapture':{'pose':pose,'settings':capture,'width':photo.get('width'),'height':photo.get('height')},
                     'scene':{'era':manifest['era'],'snapshotId':manifest.get('snapshotId'),'buildKey':build},
                     'availability':{'compose':compose,'replay':replay,'reason':reason}}
                previous=photos.get(row['id'])
                pixels=(photo.get('width') or 0)*(photo.get('height') or 0)
                previous_pixels=0 if previous is None else (previous['originalCapture'].get('width') or 0)*(previous['originalCapture'].get('height') or 0)
                # Match the gallery producer: largest image wins; equal-size ties keep the first.
                if previous is None or pixels>previous_pixels:photos[row['id']]=row
    return {'schema':'steward-capture-catalog/v1','downloadsEnabled':False,'photos':list(photos.values())}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--gallery',type=Path,action='append',required=True)
    p.add_argument('--archive',type=Path,required=True);p.add_argument('--out',type=Path,required=True);args=p.parse_args()
    read=lambda p:json.loads(p.read_text(encoding='utf-8'))
    catalog=project([read(p) for p in args.gallery],read(args.archive));args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(catalog,indent=2)+'\n',encoding='utf-8');print(f"{len(catalog['photos'])} photographs -> {args.out}")
