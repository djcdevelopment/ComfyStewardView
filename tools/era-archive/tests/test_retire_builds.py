import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import retire_builds
from capture_worker import unfinished


def shot(build, index):
    return {'shotKey': f'{build}-{index}', 'shot': f'orbit{index}', 'tsv': 'row',
            'framesWholeBuild': True}


def campaign_root(temp, deletable=('copy1',)):
    """Three subjects: two copies of one template and one distinct build.

    'copy1' is fully photographed, 'copy2' half, 'real' untouched -- the three states a
    live campaign is actually in when someone stops it partway.
    """
    root = Path(temp)
    (root / 'images/run').mkdir(parents=True)
    builds = []
    for name, pieces in (('copy1', 1629), ('copy2', 1629), ('real', 812)):
        builds.append({'buildKey': name, 'localClusterId': len(builds) + 1, 'pieces': pieces,
                       'membershipSha256': 'm-' + name,
                       'shots': [shot(name, i) for i in (1, 2)]})
    plan = {'schema': 'steward-local-campaign/v1', 'era': 'era14', 'sourceKey': 'src',
            'snapshotId': 1007, 'world': 'w', 'batchSize': 100, 'builds': builds}
    completed = {}
    for key in ('copy1-1', 'copy1-2', 'copy2-1'):
        name = f'images/run/{key}.png'
        (root / name).write_bytes(b'x' * 10)
        completed[key] = {'file': name, 'metadata': {'bytes': 10, 'dimensions': [3840, 2160]},
                          'sha256': hashlib.sha256(b'x' * 10).hexdigest(),
                          'receipt': {'cluster_id': 1, 'shot': 'orbit1'}}
    retire_builds.write(root / 'campaign.json', plan)
    retire_builds.write(root / 'state.json', {'sourceKey': 'src', 'completed': completed,
                                              'attempts': {'batch-0000': 1}, 'status': 'stopped'})
    retire_builds.write(root / 'runtime.json',
                        {'sourceKey': 'src', 'campaign': retire_builds.stamp(root / 'campaign.json')})
    retire_builds.write(root / 'status.json', {'state': 'stopped', 'gamePid': None})
    retire_builds.write(root / 'retire-era14.json',
                        {'schema': 'steward-template-retirement/v1', 'era': 'era14',
                         'sourceKey': 'src', 'snapshotId': 1007, 'method': 'histogram',
                         'params': {'minFamily': 2}, 'families': [{'templateKey': 't',
                         'copies': 2, 'pieces': 1629, 'shotsIfKept': 4}],
                         'retireBuildKeys': ['copy1', 'copy2'],
                         'deleteCapturedBuildKeys': list(deletable)})
    return root


def run(root, *extra):
    argv = ['retire_builds.py', '--root', str(root), '--retire-file',
            str(root / 'retire-era14.json'), '--reason', 'template', *extra]
    with patch.object(sys, 'argv', argv), patch.object(retire_builds, 'acquire_lock',
                                                       lambda _root: None):
        retire_builds.main()


class RetireBuildsTests(unittest.TestCase):
    def test_retirement_empties_shots_without_moving_any_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            root = campaign_root(temp)
            run(root, '--delete-captured')
            plan = retire_builds.read(root / 'campaign.json')
            # Positions preserved: batches are index chunks and runs/<batch>-attempt-NN
            # already exists on disk, so a shifted partition would collide on mkdir.
            self.assertEqual(['copy1', 'copy2', 'real'], [b['buildKey'] for b in plan['builds']])
            self.assertEqual([[], [], 2], [b['shots'] if not b['shots'] else len(b['shots'])
                                           for b in plan['builds']])
            self.assertEqual(['copy1', 'copy2'], plan['retiredBuildKeys'])
            # And the supervisor now sees only the distinct build as schedulable.
            state = retire_builds.read(root / 'state.json')
            self.assertEqual(['real'], [b['buildKey'] for b in
                                        unfinished(plan['builds'], state['completed'])])

    def test_only_nominated_builds_lose_photographs_already_taken(self):
        with tempfile.TemporaryDirectory() as temp:
            root = campaign_root(temp, deletable=('copy1',))
            run(root, '--delete-captured')
            state = retire_builds.read(root / 'state.json')
            self.assertEqual({'copy2-1'}, set(state['completed']))
            self.assertFalse((root / 'images/run/copy1-1.png').exists())
            self.assertTrue((root / 'images/run/copy2-1.png').exists())
            retired = retire_builds.read(root / 'retired.json')
            records = {b['buildKey']: b for b in retired['builds']}
            # The journal row survives the file: sha256 and receipt still prove what was shot.
            self.assertEqual(2, len(records['copy1']['deletedPhotographs']))
            self.assertTrue(all(p['sha256'] and p['receipt']
                                for p in records['copy1']['deletedPhotographs']))
            self.assertNotIn('deletedPhotographs', records['copy2'])
            receipt = retire_builds.read(root / 'prune-receipt.json')
            self.assertEqual((2, 4, 1, 20), (receipt['retiredBuilds'], receipt['plannedShotsRemoved'],
                                             receipt['pendingShotsRemoved'], receipt['bytesFreed']))
            self.assertEqual((6, 2), (receipt['targetShotsBefore'], receipt['targetShotsAfter']))

    def test_without_the_flag_captured_photographs_are_left_alone(self):
        with tempfile.TemporaryDirectory() as temp:
            root = campaign_root(temp)
            run(root)
            self.assertTrue((root / 'images/run/copy1-1.png').exists())
            self.assertEqual(3, len(retire_builds.read(root / 'state.json')['completed']))
            self.assertEqual(3, retire_builds.read(root / 'prune-receipt.json')
                             ['capturedPhotographsKept'])

    def test_runtime_digest_is_restamped_so_the_supervisor_still_starts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = campaign_root(temp)
            before = retire_builds.read(root / 'runtime.json')['campaign']
            run(root, '--delete-captured')
            runtime = retire_builds.read(root / 'runtime.json')
            self.assertNotEqual(before, runtime['campaign'])
            self.assertEqual(retire_builds.stamp(root / 'campaign.json'), runtime['campaign'])
            self.assertEqual(before, retire_builds.read(root / 'prune-receipt.json')['campaignBefore'])

    def test_dry_run_changes_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = campaign_root(temp)
            before = retire_builds.stamp(root / 'campaign.json')
            run(root, '--delete-captured', '--dry-run')
            self.assertEqual(before, retire_builds.stamp(root / 'campaign.json'))
            self.assertTrue((root / 'images/run/copy1-1.png').exists())
            self.assertFalse((root / 'prune-receipt.json').exists())
            self.assertFalse((root / 'retired.json').exists())

    def test_refuses_a_campaign_that_is_still_running_or_already_edited(self):
        with tempfile.TemporaryDirectory() as temp:
            root = campaign_root(temp)
            retire_builds.write(root / 'status.json', {'state': 'capturing', 'gamePid': 42})
            with self.assertRaises(SystemExit):run(root)
            retire_builds.write(root / 'status.json', {'state': 'stopped', 'gamePid': 999})
            with self.assertRaises(SystemExit):run(root)
            retire_builds.write(root / 'status.json', {'state': 'stopped', 'gamePid': None})
            plan = retire_builds.read(root / 'campaign.json')
            plan['builds'][0]['pieces'] = 1
            retire_builds.write(root / 'campaign.json', plan)   # digest no longer matches runtime
            with self.assertRaises(SystemExit):run(root)

    def test_refuses_a_list_from_another_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = campaign_root(temp)
            listing = retire_builds.read(root / 'retire-era14.json')
            listing['snapshotId'] = 1006
            retire_builds.write(root / 'retire-era14.json', listing)
            with self.assertRaises(SystemExit):run(root)


if __name__ == '__main__':
    unittest.main()
