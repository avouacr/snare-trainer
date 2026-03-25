"""
Batuc Trainer — stdlib-only static server.

Run with:  python main.py
"""
import http.server
import json
import os
import socketserver
from pathlib import Path

PORT = 8000
ROOT = Path(os.path.dirname(os.path.abspath(__file__)))


def validate_patterns():
    path = ROOT / 'patterns' / 'patterns.json'
    patterns = json.loads(path.read_text())
    errors = [
        f"  '{p['name']}': length {len(p['pattern'])} is not a multiple of 4"
        for p in patterns
        if len(p['pattern']) % 4 != 0
    ]
    if errors:
        raise ValueError('Invalid patterns:\n' + '\n'.join(errors))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.path = '/static/index.html'
        return super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise


validate_patterns()
os.chdir(ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Batuc Trainer -> http://localhost:{PORT}')
    httpd.serve_forever()
