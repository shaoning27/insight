#!/usr/bin/env python3
"""Insight HTML crawler collector. Python 3.9+, standard library only.
Use rename/create log rotation, delaycompress, and retain logs until acknowledged.
"""
import argparse
import datetime as dt
import fcntl
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

class PermanentError(Exception):
    pass

class RetryableError(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect)
MAX_LINE = 65536

def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
            json.dump(value, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)

def load_config(path):
    path = Path(path)
    if path.stat().st_mode & 0o077:
        raise PermanentError('Configuration must have mode 0600 (chmod 600).')
    c = json.loads(path.read_text())
    for key in ('endpoint', 'site_id', 'token', 'host', 'log_glob', 'state_path'):
        if not isinstance(c.get(key), str) or not c[key]:
            raise PermanentError('Missing configuration field: ' + key)
    u = urllib.parse.urlsplit(c['endpoint'])
    if u.scheme != 'https' and not (u.scheme == 'http' and u.hostname in ('127.0.0.1', '::1', 'localhost')):
        raise PermanentError('Upload endpoint must use HTTPS.')
    if u.username or u.password or u.query or u.fragment or not u.path.endswith('/api/crawlers/ingest'):
        raise PermanentError('Invalid upload endpoint.')
    if not re.fullmatch(r'[a-f0-9]{64}', c['token']):
        raise PermanentError('Invalid ingestion token.')
    c['host'] = c['host'].lower().removeprefix('www.').rstrip('.')
    c['catalog'] = urllib.parse.urlunsplit((u.scheme, u.netloc, u.path[:-len('ingest')] + 'catalog', '', ''))
    return c

def fetch_json(url, payload=None, token=None):
    headers = {'Accept': 'application/json', 'User-Agent': 'Insight-Log-Collector/1.0'}
    data = None
    if payload is not None:
        data = json.dumps(payload, separators=(',', ':')).encode()
        headers['Content-Type'] = 'application/json'
        headers['Authorization'] = 'Bearer ' + token
    try:
        with OPENER.open(urllib.request.Request(url, data=data, headers=headers), timeout=30) as res:
            body = res.read(1048576)
            return json.loads(body)
    except urllib.error.HTTPError as error:
        if error.code == 429 or error.code >= 500:
            raise RetryableError('Upload temporarily unavailable (HTTP %s).' % error.code) from None
        raise PermanentError('Server rejected request (HTTP %s); cursor preserved. Check token, enabled mode, site and log format.' % error.code) from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise RetryableError('Network or JSON response failure; cursor preserved.') from None

def parse_line(line, config, pattern):
    try:
        e = json.loads(line)
        if not isinstance(e, dict):
            raise ValueError()
        host = str(e.get('host', '')).lower().removeprefix('www.').rstrip('.')
        if host != config['host'] or e.get('method') not in ('GET', 'HEAD'):
            return None
        if not re.match(r'^text/html(?:\s*;|$)', str(e.get('content_type', '')), re.I):
            return None
        ua = e.get('ua')
        uri = e.get('uri')
        if not isinstance(ua, str) or not isinstance(uri, str):
            raise ValueError()
        # Remove documentation URLs before applying the server's shared catalog.
        if not pattern.search(re.sub(r'https?://[^\s;)]+', '', ua, flags=re.I)):
            return None
        path = re.split(r'[?#]', uri, maxsplit=1)[0]
        if re.search(r'\.(js|css|map|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|pdf|xml|txt)$', path, re.I):
            return None
        if not path.startswith('/') or path.startswith('//') or len(path) > 2048 or len(ua) > 512:
            raise ValueError()
        if re.search(r'[\x00-\x1f\x7f]', path + ua):
            raise ValueError()
        timestamp = str(e.get('time', ''))
        parsed = dt.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        age = (dt.datetime.now(dt.timezone.utc) - parsed).total_seconds()
        if age > 90 * 86400 or age < -300:
            print('Skipped a log record outside the 90-day / 5-minute clock window.', file=sys.stderr)
            return None
        status = e.get('status')
        if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
            raise ValueError()
        return {'ts': parsed.isoformat(), 'host': host, 'method': e['method'], 'content_type': e['content_type'], 'path': path, 'user_agent': ua, 'status_code': status}
    except (ValueError, TypeError, UnicodeDecodeError):
        print('Skipped a malformed completed log line; no raw content logged.', file=sys.stderr)
        return None

def collect_once(c):
    state_path = Path(c['state_path'])
    if state_path.exists():
        state = json.loads(state_path.read_text())
        if state.get('version') != 1 or not isinstance(state.get('files'), dict):
            raise PermanentError('Invalid cursor file; restore it rather than resetting it.')
    else:
        state = {'version': 1, 'source_id': uuid.uuid4().hex, 'files': {}}
        private_json(state_path, state)
    catalog = fetch_json(c['catalog'])
    try:
        pattern = re.compile(catalog['regex'], re.I)
    except (KeyError, TypeError, re.error):
        raise PermanentError('Invalid crawler catalog.') from None
    candidates = []
    for name in glob.glob(c['log_glob']):
        p = Path(name)
        if p.suffix in ('.gz', '.zip', '.bz2', '.xz'):
            continue
        try:
            with p.open('rb') as f:
                info = os.fstat(f.fileno())
                if not stat.S_ISREG(info.st_mode):
                    continue
                first = f.readline(MAX_LINE + 1)
        except FileNotFoundError:
            raise RetryableError('Log rotated during discovery; retrying without advancing the cursor.') from None
        if not first or (not first.endswith(b'\n') and len(first) <= MAX_LINE):
            continue
        fingerprint = hashlib.sha256(first[:256]).hexdigest()
        key = '%s:%s:%s' % (info.st_dev, info.st_ino, fingerprint)
        candidates.append((info.st_mtime_ns, p, key, info.st_size))
    candidates.sort(key=lambda item: (item[0], str(item[1])))
    found = {item[2] for item in candidates}
    for key, entry in list(state['files'].items()):
        if key not in found:
            if entry['offset'] < entry['size']:
                raise PermanentError('An unacknowledged rotated log is missing or changed. Restore the file; cursor preserved.')
            del state['files'][key]
    if not candidates and not glob.glob(c['log_glob']):
        raise PermanentError('No matching logs found. Check log_glob and file permissions.')
    sent = 0
    scanned = 0
    for _, filename, key, observed_size in candidates:
        entry = state['files'].setdefault(key, {'offset': 0, 'generation': uuid.uuid4().hex, 'size': observed_size})
        if observed_size < entry['offset']:
            raise PermanentError('Log truncation detected. Use rename/create rotation; cursor preserved.')
        entry['size'] = observed_size
        private_json(state_path, state)  # persist identity BEFORE a request can be retried
        try:
            log = filename.open('rb')
        except FileNotFoundError:
            raise RetryableError('Log rotated during scan; retrying without advancing the cursor.') from None
        with log:
            actual = os.fstat(log.fileno())
            first = log.readline(MAX_LINE + 1)
            actual_key = '%s:%s:%s' % (actual.st_dev, actual.st_ino, hashlib.sha256(first[:256]).hexdigest())
            if actual_key != key:
                raise RetryableError('Log rotated during scan; retrying without advancing the cursor.')
            log.seek(entry['offset'])
            while scanned < 5000:
                events = []
                batch_bytes = 0
                end = log.tell()
                partial = False
                for _ in range(500):
                    start = log.tell()
                    line = log.readline(MAX_LINE + 1)
                    if not line:
                        break
                    if len(line) > MAX_LINE:
                        while line and not line.endswith(b'\n'):
                            line = log.readline(MAX_LINE + 1)
                        if not line:
                            partial = True
                            break
                        print('Skipped an oversized completed log line.', file=sys.stderr)
                        end = log.tell()
                        scanned += 1
                        continue
                    if not line.endswith(b'\n'):
                        partial = True
                        break
                    event = parse_line(line, c, pattern)
                    if event:
                        event['id'] = hashlib.sha256(('%s:%s:%s:%s' % (state['source_id'], key, entry['generation'], start)).encode()).hexdigest()
                        length = len(json.dumps(event).encode())
                        if events and batch_bytes + length > 400000:
                            log.seek(start)
                            break
                        events.append(event)
                        batch_bytes += length
                    end = log.tell()
                    scanned += 1
                    if len(events) >= 100 or scanned >= 5000:
                        break
                if events:
                    result = fetch_json(c['endpoint'], {'site_id': c['site_id'], 'source_id': state['source_id'], 'requests': events}, c['token'])
                    if result.get('ok') is not True:
                        raise RetryableError('Server did not acknowledge the batch; cursor preserved.')
                    sent += len(events)
                if end > entry['offset']:
                    entry['offset'] = end
                    private_json(state_path, state)
                if partial or end == log.tell() and not events and end == observed_size:
                    break
                if log.tell() >= observed_size:
                    break
        if scanned >= 5000:
            break
    return sent

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    try:
        c = load_config(args.config)
        lock = Path(c['state_path'] + '.lock')
        lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with os.fdopen(os.open(lock, os.O_CREAT | os.O_RDWR, 0o600), 'w') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise PermanentError('Another collector is using this cursor.') from None
            delay = 5
            while True:
                try:
                    count = collect_once(c)
                    if count:
                        print('Acknowledged %d crawler observations.' % count, flush=True)
                    if args.once:
                        return 0
                    delay = 5
                except RetryableError as error:
                    print(str(error), file=sys.stderr, flush=True)
                    if args.once:
                        return 1
                    delay = min(delay * 2, 300)
                time.sleep(delay)
    except (PermanentError, OSError, ValueError, KeyError) as error:
        # Never print configuration values or HTTP payloads.
        print('Collector stopped: ' + (str(error) if isinstance(error, PermanentError) else 'invalid local file or configuration'), file=sys.stderr)
        return 2

if __name__ == '__main__':
    sys.exit(main())
