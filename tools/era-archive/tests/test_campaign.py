import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from campaign import completed_builds, select_jobs
from capture_worker import Worker, disk_stop, png_metadata, progress_stalled, should_retry, unfinished


class CampaignTests(unittest.TestCase):
    def test_selection_keeps_coverage_order_and_rejects_other_sources(self):
        era={'era':14,'snapshotId':1007,'sourceKey':'a'}
        base={**era,'kind':'photography','priorityInvestigation':False}
        jobs=[{**base,'buildKey':'done'},{**base,'buildKey':'investigate','priorityInvestigation':True},
              {**base,'buildKey':'wrong','sourceKey':'b'},{**base,'buildKey':'old','snapshotId':1006},
              {**base,'buildKey':'first'},{**base,'buildKey':'first'},{**base,'buildKey':'second'}]
        self.assertEqual(['first','second'],[j['buildKey'] for j in select_jobs(jobs,era,{'done'},2)])
        with self.assertRaises(ValueError):select_jobs(jobs,era,{'done'},3)

    def test_completed_landmark_requires_all_four_real_receipts(self):
        pilot={'sourceKey':'a','builds':[{'buildKey':'build','localClusterId':1}]}
        rows=[{'cluster_id':1,'shot':f'orbit{i}','file':f'{i}.png'} for i in range(1,5)]
        self.assertEqual({'build'},completed_builds(pilot,rows,'a'))
        rows[3]['skipped']='world_never_loaded'
        self.assertEqual(set(),completed_builds(pilot,rows,'a'))
        with self.assertRaises(ValueError):completed_builds(pilot,rows,'other')

    def test_resume_keeps_only_unfinished_angles_without_changing_ids(self):
        builds=[{'localClusterId':73,'shots':[{'shotKey':'a'},{'shotKey':'b'}]},
                {'localClusterId':74,'shots':[{'shotKey':'c'}]}]
        self.assertEqual([{'localClusterId':73,'shots':[{'shotKey':'b'}]}],unfinished(builds,{'a':{},'c':{}}))
        self.assertEqual(2,len(builds[0]['shots']))

    def test_disk_limits_and_watchdog_boundaries(self):
        plan={'maxOutputBytes':32,'minFreeBytes':20}
        self.assertIsNone(disk_stop(31,20,plan))
        self.assertEqual('output-limit',disk_stop(32,20,plan))
        self.assertEqual('disk-reserve',disk_stop(0,19,plan))
        self.assertFalse(progress_stalled(100,999));self.assertTrue(progress_stalled(100,1000))
        self.assertTrue(should_retry(1));self.assertFalse(should_retry(2))

    def test_truncated_png_cannot_be_counted_as_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'capture.png'
            p.write_bytes(b'\x89PNG\r\n\x1a\n'+b'\0'*8+struct.pack('>II',3840,2160))
            with self.assertRaises(ValueError):png_metadata(p)
            with p.open('ab') as f:f.write(b'\0\0\0\0IEND\xaeB`\x82')
            self.assertEqual([3840,2160],png_metadata(p)['dimensions'])

    def test_harvest_is_durable_and_other_era_or_unsafe_receipts_are_ignored(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);cfg=root/'cfg';cfg.mkdir();captures=cfg/'comfy-orbit-captures'
            raw=captures/'20260909-050000'/'0001_orbit1.png';raw.parent.mkdir(parents=True)
            raw.write_bytes(b'\x89PNG\r\n\x1a\n'+b'\0'*8+struct.pack('>II',3840,2160)+b'\0\0\0\0IEND\xaeB`\x82')
            row={'cluster_id':1,'shot':'orbit1','run':'20260909-050000','file':raw.name}
            (cfg/'shotplan-receipts.jsonl').write_text('\n'.join(map(json.dumps,[row,{**row,'cluster_id':999},
                        {**row,'file':'../escape.png'},{**row,'run':'../other'}]))+'\n{"unfinished":')
            worker=Worker.__new__(Worker);worker.root=root;worker.cfg=cfg;worker.capture_root=captures
            worker.plan={'width':3840,'height':2160};worker.state={'completed':{}}
            allowed={(1,'orbit1'):{'shotKey':'a'}}
            found=worker.read_receipts(allowed);self.assertEqual(1,len(found))
            worker.harvest(found)
            saved=json.loads((root/'state.json').read_text())['completed']['a']
            self.assertTrue((root/saved['file']).exists());self.assertFalse(raw.exists())
            worker.harvest(found)  # completed journal prevents duplicate copy on recovery
            self.assertEqual(1,len(worker.state['completed']))


if __name__=='__main__':unittest.main()
