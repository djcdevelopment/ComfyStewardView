#!/usr/bin/env python3
"""Prepare one verified ready era as an incremental world-catalog package."""
import argparse
from pathlib import Path

from archive import artifact, checked_file, digest, load, now, save
from world_bundle import add_ready


def prepare(output_root, ready_inputs, era_slug, destination):
    output_root=Path(output_root).resolve();destination=Path(destination).resolve()
    if destination.exists():raise ValueError('Use a new immutable era package directory')
    ready=load(ready_inputs)
    matches=[item for item in ready['eras'] if item['slug']==era_slug]
    if len(matches)!=1:raise ValueError(f'Expected one ready input for {era_slug}, found {len(matches)}')
    spec=matches[0]
    sources={item['slug']:item for item in load(output_root/'catalog.json')['eras']}
    if era_slug not in sources:raise ValueError('Era is absent from the archive catalog')
    source=sources[era_slug]
    metadata=load(str(spec['cache'])+'.json')
    if metadata.get('snapshotHash')!=source['db']['sha256']:
        raise ValueError('Ready cache is not the inventoried source revision')
    analyses={item['slug']:item for item in load(output_root/'analysis/catalog.json')['eras']}
    analysis=analyses[era_slug]
    if analysis['sourceKey']!=source['sourceKey']:
        raise ValueError('Build analysis source revision mismatch')
    exact=checked_file(output_root,analysis['membership'])
    if not spec.get('membership') or digest(Path(spec['membership']))!=digest(exact):
        raise ValueError('Incremental era requires its verified exact build membership')
    destination.mkdir(parents=True)
    entry=add_ready(destination,spec)
    save(destination/'entry.json',entry)
    files=[artifact(destination,path) for path in sorted((destination/era_slug).rglob('*')) if path.is_file()]
    receipt={'schema':'steward-world-era-package/v1','createdAt':now(),'era':era_slug,
             'snapshotId':entry['snapshotId'],'entry':entry,'files':files}
    save(destination/'receipt.json',receipt)
    return receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-root',type=Path,required=True)
    parser.add_argument('--ready-inputs',type=Path,required=True)
    parser.add_argument('--era',required=True)
    parser.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args()
    receipt=prepare(args.output_root,args.ready_inputs,args.era,args.destination)
    print(f"{receipt['era']}: incremental package verified ({len(receipt['files'])} files)")


if __name__=='__main__':main()
