"""
Snare Trainer — stdlib-only static server + pattern list API.

Run with:  python main.py
"""
import http.server
import json
import os
import socketserver
from pathlib import Path

PORT = 8000
ROOT = Path(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.path = '/static/index.html'
            return super().do_GET()
        if self.path == '/api/patterns':
            self._serve_json(
                [p.stem for p in sorted((ROOT / 'patterns').glob('*.json'))]
            )
            return
        return super().do_GET()

    def _serve_json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise


os.chdir(ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Snare Trainer -> http://localhost:{PORT}')
    httpd.serve_forever()
