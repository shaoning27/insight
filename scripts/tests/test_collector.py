import json, tempfile, subprocess, threading, unittest, sys, os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
SCRIPT=Path(__file__).resolve().parents[2]/'app/public/insight-log-collector.py'
class CollectorTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.dir=Path(self.tmp.name);self.posts=[];self.status=200
  parent=self
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*a):pass
   def do_GET(self):
    self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'regex':'Kimi-User|HySpider|GLMBot'}).encode())
   def do_POST(self):
    parent.posts.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
    self.send_response(parent.status);self.end_headers();self.wfile.write(json.dumps({'ok':parent.status==200}).encode())
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=self.server.serve_forever,daemon=True).start()
  self.log=self.dir/'access.log';self.state=self.dir/'state.json';self.config=self.dir/'config.json'
  self.config.write_text(json.dumps({'endpoint':f'http://127.0.0.1:{self.server.server_port}/api/crawlers/ingest','site_id':'test-site','token':'a'*64,'host':'example.com','log_glob':str(self.log)+'*','state_path':str(self.state)}));self.config.chmod(0o600)
 def tearDown(self):self.server.shutdown();self.server.server_close();self.tmp.cleanup()
 def event(self,**changes):
  e={'time':datetime.now(timezone.utc).isoformat(),'host':'example.com','method':'GET','content_type':'text/html','uri':'/article?secret=redacted','ua':'Kimi-User/1.0','status':200};e.update(changes);return json.dumps(e).encode()+b'\n'
 def run_collector(self):return subprocess.run([sys.executable,str(SCRIPT),'--config',str(self.config),'--once'],capture_output=True,timeout=15)
 def test_collects_html_once_and_preserves_identity_after_response_failure(self):
  self.log.write_bytes(self.event());self.status=503
  self.assertEqual(self.run_collector().returncode,1)
  first=self.posts[0]['requests'][0]['id'];self.status=200
  self.assertEqual(self.run_collector().returncode,0)
  self.assertEqual(self.posts[1]['requests'][0]['id'],first)
  self.assertEqual(self.posts[0]['source_id'],self.posts[1]['source_id'])
  self.assertEqual(self.posts[1]['requests'][0]['path'],'/article')
  self.assertEqual(self.run_collector().returncode,0);self.assertEqual(len(self.posts),2)
  self.assertEqual(self.state.stat().st_mode & 0o777,0o600)
 def test_filters_other_hosts_assets_methods_and_humans(self):
  self.log.write_bytes(self.event(host='other.example')+self.event(content_type='image/png')+self.event(method='POST')+self.event(ua='Mozilla/5.0 Chrome/140')+self.event())
  self.assertEqual(self.run_collector().returncode,0)
  self.assertEqual(len(self.posts),1);self.assertEqual(len(self.posts[0]['requests']),1)
 def test_incomplete_line_waits_for_newline(self):
  line=self.event();self.log.write_bytes(line[:-1]);self.assertEqual(self.run_collector().returncode,0);self.assertEqual(self.posts,[])
  with self.log.open('ab') as f:f.write(b'\n')
  self.assertEqual(self.run_collector().returncode,0);self.assertEqual(len(self.posts),1)
 def test_rename_rotation_drains_old_file_before_new_file(self):
  self.log.write_bytes(self.event(uri='/first'));self.assertEqual(self.run_collector().returncode,0)
  with self.log.open('ab') as f:f.write(self.event(uri='/old-tail'))
  self.log.rename(self.dir/'access.log.1');self.log.write_bytes(self.event(uri='/new'))
  self.assertEqual(self.run_collector().returncode,0)
  paths=[e['path'] for b in self.posts for e in b['requests']]
  self.assertEqual(paths,['/first','/old-tail','/new'])
 def test_malformed_completed_line_is_skipped_without_blocking(self):
  self.log.write_bytes(b'not json\n'+self.event());result=self.run_collector();self.assertEqual(result.returncode,0);self.assertEqual(len(self.posts[0]['requests']),1)
 def test_permanent_auth_error_stops_without_advancing_cursor(self):
  self.log.write_bytes(self.event());self.status=401
  self.assertEqual(self.run_collector().returncode,2)
  self.status=200;self.assertEqual(self.run_collector().returncode,0);self.assertEqual(len(self.posts),2)
 def test_missing_unacknowledged_rotation_is_reported(self):
  self.log.write_bytes(self.event());self.status=503;self.assertEqual(self.run_collector().returncode,1)
  self.log.unlink();self.log.write_bytes(self.event(uri='/replacement'));self.status=200
  self.assertEqual(self.run_collector().returncode,2)
 def test_oversized_first_line_does_not_hide_following_records(self):
  self.log.write_bytes(b'x'*70000+b'\n'+self.event());self.assertEqual(self.run_collector().returncode,0)
  self.assertEqual(len(self.posts),1)
 def test_rotation_during_scan_preserves_old_file_cursor(self):
  import importlib.util
  from unittest.mock import patch
  spec=importlib.util.spec_from_file_location('collector',SCRIPT);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  self.log.write_bytes(self.event(uri='/old'));original=Path.open;counter=[0]
  def opening(path,*args,**kwargs):
   if path==self.log and args and args[0]=='rb':
    counter[0]+=1
    if counter[0]==2:
     path.rename(self.dir/'access.log.1');path.write_bytes(self.event(uri='/new'))
   return original(path,*args,**kwargs)
  with patch.object(Path,'open',opening):
   with self.assertRaises(module.RetryableError):module.collect_once(module.load_config(self.config))
  self.assertEqual(self.posts,[])
  self.assertEqual(self.run_collector().returncode,0)
  self.assertEqual([e['path'] for b in self.posts for e in b['requests']],['/old','/new'])
 def test_discovery_rename_is_retryable(self):
  import importlib.util
  from unittest.mock import patch
  spec=importlib.util.spec_from_file_location('collector',SCRIPT);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  self.log.write_bytes(self.event());original=Path.open;counter=[0]
  def opening(path,*args,**kwargs):
   if path==self.log and args and args[0]=='rb' and not counter[0]:
    counter[0]+=1;path.rename(self.dir/'access.log.1')
   return original(path,*args,**kwargs)
  with patch.object(Path,'open',opening):
   with self.assertRaises(module.RetryableError):module.collect_once(module.load_config(self.config))
 def test_rotated_partial_tail_does_not_block_new_log(self):
  (self.dir/'access.log.1').write_bytes(self.event(uri='/old')+b'{"unfinished":')
  self.log.write_bytes(self.event(uri='/new'))
  self.assertEqual(self.run_collector().returncode,0)
  self.assertEqual([e['path'] for b in self.posts for e in b['requests']],['/old','/new'])
  self.assertEqual(self.run_collector().returncode,0);self.assertEqual(len(self.posts),2)
 def test_world_readable_configuration_is_rejected(self):
  self.log.write_bytes(self.event());self.config.chmod(0o644)
  self.assertEqual(self.run_collector().returncode,2);self.assertEqual(self.posts,[])
if __name__=='__main__':unittest.main()
