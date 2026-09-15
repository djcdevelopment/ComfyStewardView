import copy
import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).resolve().parents[1]/'capture_catalog.py'
spec=importlib.util.spec_from_file_location('capture_catalog',path);catalog=importlib.util.module_from_spec(spec);spec.loader.exec_module(catalog)


class CaptureCatalogTests(unittest.TestCase):
    def setUp(self):
        self.archive={'eras':[{'slug':'era11','sourceKey':'source','worldId':'ComfyEra11','archiveWorldId':'ComfyEra11',
          'db':{'path':'private/world.db','bytes':10,'sha256':'a'*64},'fwl':{'path':'private/world.fwl','bytes':11,'sha256':'b'*64}}]}
        self.photo={'id':'era11-reference','thumb':'https://example.test/thumb.webp','large':'https://example.test/large.webp','width':3840,'height':2160,
          'pose':{'lens':{'x':100,'y':31.7,'z':200},'aim':{'x':100,'y':31.7,'z':240},'yaw':0,'pitch':0,'fov':72},
          'capture':{'environment':'Clear','time_of_day':.64,'fires':False}}
        self.manifest={'schema':'steward-capture-gallery/v1','sourceKey':'source','era':'era11','snapshotId':1005,'builds':{'c'*64:[self.photo]}}
    def test_reuses_derivatives_preserves_lens_and_recorded_fov(self):
        doc=catalog.project([self.manifest],self.archive);p=doc['photos'][0]
        self.assertFalse(doc['downloadsEnabled']);self.assertTrue(p['availability']['replay']);self.assertEqual([100,31.7,200],p['camera']['lens'])
        self.assertEqual(72,p['camera']['verticalFov']);self.assertEqual(1920,p['camera']['width']);self.assertEqual(3840,p['originalCapture']['width'])
        self.assertEqual(self.photo['thumb'],p['images']['thumbnail']);self.assertNotIn('path',p['source']['world']['db'])
    def test_incomplete_photos_remain_browsable(self):
        del self.photo['pose'];p=catalog.project([self.manifest],self.archive)['photos'][0]
        self.assertFalse(p['availability']['compose']);self.assertIn('unavailable',p['availability']['reason']);self.assertEqual('era11-reference',p['id'])
    def test_source_mismatch_never_attaches_another_world(self):
        self.manifest['sourceKey']='wrong';p=catalog.project([self.manifest],self.archive)['photos'][0]
        self.assertFalse(p['availability']['compose']);self.assertFalse(p['availability']['replay']);self.assertNotIn('db',p['source']['world'])
    def test_missing_lighting_keeps_composition_without_replay(self):
        del self.photo['capture']['fires'];p=catalog.project([self.manifest],self.archive)['photos'][0]
        self.assertTrue(p['availability']['compose']);self.assertFalse(p['availability']['replay'])
    def test_multi_manifest_selection_matches_gallery_largest_frame(self):
        smaller=copy.deepcopy(self.manifest);p=smaller['builds']['c'*64][0];p['width']=1920;p['height']=1080;p['pose']['fov']=35
        row=catalog.project([self.manifest,smaller],self.archive)['photos'][0]
        self.assertEqual(3840,row['originalCapture']['width']);self.assertEqual(72,row['camera']['verticalFov'])


if __name__=='__main__':unittest.main()
