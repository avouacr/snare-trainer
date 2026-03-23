"""
Snare Trainer — stdlib-only static server.

Run with:  python main.py
"""
import http.server
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

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise


os.chdir(ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Snare Trainer -> http://localhost:{PORT}')
    httpd.serve_forever()
