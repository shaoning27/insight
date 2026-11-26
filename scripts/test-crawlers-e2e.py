#!/usr/bin/env python3
"""Run only against the isolated candidate container, never the production auth volume."""
import argparse, base64, hashlib, hmac, json, os, re, secrets, struct, subprocess, tempfile, time
from pathlib import Path
from http.cookies import SimpleCookie
from datetime import datetime, timezone, timedelta
import urllib.request, urllib.error

def check(value, label):
    if not value: raise AssertionError(label)
    print('PASS ' + label, flush=True)

def sql(query):
    return subprocess.check_output(['docker','exec','insight-crawler-test-db','sh','-c',
        'exec clickhouse-client --password "$CLICKHOUSE_PASSWORD" --query "$1"','sh',query],text=True).strip()

def run(base, envfile):
    for container in ('insight-crawler-test-db','insight-crawler-candidate'):
        label=subprocess.check_output(['docker','inspect',container,'--format','{{index .Config.Labels "codex.test"}}'],text=True).strip()
        check(label=='insight-crawlers-20261126','isolated test container identity')
        networks=json.loads(subprocess.check_output(['docker','inspect',container,'--format','{{json .NetworkSettings.Networks}}'],text=True))
        check(set(networks)=={'insight-crawler-test'},'test container has no production network')
    env=dict(line.split('=',1) for line in Path(envfile).read_text().splitlines() if '=' in line and not line.startswith('#'))
    cookies={}
    def request(path, data=None, token=None, headers=None, method=None):
        h={'Content-Type':'application/json'}
        if cookies: h['Cookie']='; '.join(k+'='+v for k,v in cookies.items())
        if token: h['Authorization']='Bearer '+token
        if headers: h.update(headers)
        req=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),headers=h,method=method)
        try: response=urllib.request.urlopen(req,timeout=90)
        except urllib.error.HTTPError as error: response=error
        with response:
            for line in response.headers.get_all('Set-Cookie',[]):
                parsed=SimpleCookie();parsed.load(line)
                for k,v in parsed.items():
                    if v.value: cookies[k]=v.value
                    else: cookies.pop(k,None)
            raw=response.read()
            try: result=json.loads(raw)
            except ValueError: result=raw.decode()
            return response.status,result
    status,_=request('/api/health');check(status==200,'candidate health')
    status,_=request('/api/sites/ingestion?id=none');check(status==401,'owner-only settings reject unauthenticated access')
    status,_=request('/api/auth/password',{'email':env['ADMIN_EMAIL'],'password':'intentionally-wrong'})
    check(status==401,'wrong password rejected')
    status,enroll=request('/api/auth/password',{'email':env['ADMIN_EMAIL'],'password':env['ADMIN_PASSWORD']})
    check(status==200 and enroll.get('step')=='enroll','candidate password and enrollment')
    secret=base64.b32decode(enroll['secret']+'='*((8-len(enroll['secret'])%8)%8))
    counter=int(time.time()//30);digest=hmac.new(secret,struct.pack('>Q',counter),hashlib.sha1).digest();offset=digest[-1]&15
    code=str((struct.unpack('>I',digest[offset:offset+4])[0]&0x7fffffff)%1000000).zfill(6)
    status,_=request('/api/auth/totp',{'code':'not-a-code'});check(status==401,'invalid 2FA rejected')
    status,_=request('/api/auth/totp',{'code':code});check(status==200,'candidate full 2FA login')
    created=[];workspace=tempfile.TemporaryDirectory(prefix='insight-nginx-e2e-');nginx=Path(workspace.name)/'nginx.conf';test_nginx=None
    suffix=secrets.token_hex(5);host='collector-e2e.invalid';log=Path(workspace.name)/'access.log'
    try:
        for name in ('A','B'):
            status,data=request('/api/sites',{'name':'e2e-'+suffix+'-'+name});check(status==200,'create isolated test site '+name)
            sid=data['site']['id'];check(bool(re.fullmatch('[a-z0-9-]+',sid)),'test site identifier safe')
            created.append(sid)
            status,_=request('/api/sites',{'id':sid,'url':'https://'+host},method='PATCH');check(status==200,'set test site URL')
        a,b=created
        status,first=request('/api/sites/ingestion',{'id':a});check(status==200 and not first['enabled'],'token generation does not enable logs')
        token=first['token']
        status,second=request('/api/sites/ingestion',{'id':b});token_b=second['token']
        status,listing=request('/api/sites');check('crawlerTokenHash' not in json.dumps(listing) and token not in json.dumps(listing),'site listing does not expose ingestion credentials')
        owner=dict(cookies);cookies.clear()
        status,_=request('/api/sites/ingestion?id='+a,token='1'*64);check(status==401,'read-only token cannot manage ingestion')
        cookies.update(owner)
        timestamp=(datetime.now(timezone.utc)-timedelta(seconds=30)).isoformat()
        tokens=['Kimi-User','Kimi-SearchBot','KimiBot','HySpider','GLMBot','Baiduspider','360Spider','Bytespider','ChatGPT-User']
        events=[{'id':'event-'+str(i).zfill(8),'ts':timestamp,'host':host,'method':'GET','content_type':'text/html','path':'/page-'+str(i)+'?private=query#fragment','user_agent':ua+'/1.0','status_code':404 if i==3 else 200} for i,ua in enumerate(tokens)]
        body={'site_id':a,'source_id':'integration-source','requests':events}
        status,_=request('/api/crawlers/ingest',body,token=token);check(status==409,'ingestion requires explicit enable')
        status,_=request('/api/sites/ingestion',{'id':a,'enabled':True},method='PATCH');check(status==200,'enable site log mode')
        status,_=request('/api/crawlers/ingest',body);check(status==401,'upload requires token')
        status,_=request('/api/crawlers/ingest',{**body,'site_id':b},token=token);check(status==401,'cross-site token rejected')
        status,result=request('/api/crawlers/ingest',body,token=token);check(status==200 and result['inserted']==9,'Chinese and international requests inserted')
        status,result=request('/api/crawlers/ingest',body,token=token);check(status==200 and result['inserted']==0 and result['duplicates']==9,'repeated batch inserts no duplicate rows')
        status,_=request('/api/crawlers/ingest',{**body,'requests':[{**events[0],'path':'/conflicting'}]},token=token);check(status==409,'conflicting event identity rejected')
        status,result=request('/api/crawlers/ingest',{**body,'requests':[{**events[0],'id':'wronghost-0001','host':'other.invalid'}]},token=token)
        check(status==200 and result['ignored']==1,'other hostname cannot pollute site data')
        status,_=request('/t.js?s='+a,headers={'User-Agent':'Kimi-User/1.0','Referer':'https://'+host+'/script'})
        check(status==200 and int(sql("SELECT count() FROM insight.ai_hits WHERE site_id='%s'"%a))==9,'log mode suppresses script crawler duplication')
        status,_=request('/t.js?s='+b,headers={'User-Agent':'Kimi-User/1.0','Referer':'https://'+host+'/legacy'})
        check(status==200 and int(sql("SELECT countIf(request_id='') FROM insight.ai_hits WHERE site_id='%s'"%b))==1,'script mode preserves legacy observations')
        request('/api/sites/ingestion',{'id':b,'enabled':True},method='PATCH')
        status,_=request('/api/crawlers/ingest',{'site_id':b,'source_id':'integration-source','requests':[events[0]]},token=token_b)
        check(status==200,'same external identity may occur on another site')
        expr="countIf(request_id='') + uniqExactIf(tuple(site_id,request_id),request_id!='')"
        check(int(sql("SELECT "+expr+" FROM insight.ai_hits WHERE site_id IN ('%s','%s')"%(a,b)))==11,'aggregation deduplicates within site and preserves cross-site records')
        # Real loopback Nginx HTML requests, not a manually authored log fixture.
        config='''pid PID_PATH;
error_log ERROR_PATH;
events {}
http {
log_format insight_e2e escape=json '{"time":"$time_iso8601","host":"$host","method":"$request_method","content_type":"$sent_http_content_type","uri":"$uri","ua":"$http_user_agent","status":$status}';
server { listen 127.0.0.1:8889; server_name collector-e2e.invalid; access_log LOG_PATH insight_e2e; default_type text/html; location /missing { return 404 '<html>missing</html>'; } location / { return 200 '<html>test</html>'; } }
}
'''.replace('LOG_PATH',str(log)).replace('PID_PATH',workspace.name+'/nginx.pid').replace('ERROR_PATH',workspace.name+'/error.log')
        with nginx.open('x') as f:f.write(config)
        subprocess.run(['nginx','-t','-c',str(nginx)],check=True,capture_output=True)
        test_nginx=subprocess.Popen(['nginx','-c',str(nginx),'-g','daemon off;'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);time.sleep(0.5)
        for path,ua in [('/collector-html','Kimi-User/1.0'),('/missing','HySpider/1.0'),('/human','Mozilla/5.0 Chrome/140.0'),('/t.js','Kimi-User/1.0')]:
            req=urllib.request.Request('http://127.0.0.1:8889'+path,headers={'Host':host,'User-Agent':ua})
            try:
                with urllib.request.urlopen(req,timeout=10) as r:r.read()
            except urllib.error.HTTPError as r:r.read()
        with tempfile.TemporaryDirectory(prefix='insight-e2e-') as d:
            cfg=Path(d)/'collector.json'
            cfg.write_text(json.dumps({'endpoint':base+'/api/crawlers/ingest','site_id':a,'token':token,'host':host,'log_glob':str(log)+'*','state_path':d+'/cursor.json'}));cfg.chmod(0o600)
            cmd=['python3','app/public/insight-log-collector.py','--config',str(cfg),'--once']
            subprocess.run(cmd,check=True,capture_output=True);subprocess.run(cmd,check=True,capture_output=True)
        check(int(sql("SELECT count() FROM insight.ai_hits WHERE site_id='%s'"%a))==11,'real Nginx HTML -> collector -> authenticated endpoint, replay stays deduplicated')
        check(sql("SELECT countIf(ip!=''),countIf(verified!=0),countIf(position(path,'?')>0),countIf(status_code=404) FROM insight.ai_hits WHERE site_id='%s'"%a)=='0\t0\t0\t2','privacy, unverified identity, clean paths and actual HTTP errors preserved')
        status,stats=request('/api/stats?site='+a+'&period=7d')
        check(status==200 and sum(x['count'] for x in stats['ai'])==11,'published crawler report matches deduplicated stored counts')
        kim=next(x for x in stats['ai'] if x['name']=='Kimi-User')
        check(kim['count']==2 and any(p['name']=='/collector-html' for p in kim['pages']),'HTML page visible in per-crawler page report')
        check(sum(sum(v for k,v in point.items() if k!='t') for point in stats['aiSeries'])>0,'crawler time series is published')
        status,new=request('/api/sites/ingestion',{'id':a});check(status==200,'rotate ingestion token')
        status,_=request('/api/crawlers/ingest',body,token=token);check(status==401,'old token is invalid immediately after rotation')
        status,_=request('/api/sites',{'id':a,'url':''},method='PATCH')
        status,state=request('/api/sites/ingestion?id='+a);check(not state['enabled'] and not state['configured'],'clearing hostname restores script mode and revokes token')
    finally:
        for sid in created:
            try:
                request('/api/sites?id='+sid,method='DELETE')
                for table in ('ai_hits','events'):
                    sql("ALTER TABLE insight.%s DELETE WHERE site_id='%s' SETTINGS mutations_sync=1"%(table,sid))
            except Exception:
                print('ERROR test site cleanup failed for an isolated test identifier',flush=True)
                raise
        if test_nginx is not None:
            test_nginx.terminate();test_nginx.wait(timeout=15)
        workspace.cleanup()
    check(all(sql("SELECT count() FROM insight.ai_hits WHERE site_id='%s'"%sid)=='0' for sid in created),'test observations removed')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8788');p.add_argument('--env',default='.env');a=p.parse_args()
    if a.base!='http://127.0.0.1:8788':raise SystemExit('This test requires the isolated loopback candidate port 8788.')
    run(a.base,a.env)
