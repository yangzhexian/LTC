#!/usr/bin/env python3
"""
HTTP server that ONLY serves main.pdf + an auto-refresh HTML page.
All other paths return 404.

Usage:
    python3 scripts/httpserver.py [port] [project-dir]
"""

import argparse
import os
import socketserver
from http import HTTPStatus
from http.server import HTTPServer, SimpleHTTPRequestHandler

AUTO_REFRESH_HTML = """\
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>LTC - PDF Preview</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%%; background: #525659; }
  embed { display: block; width: 100%%; height: 100%%; }
</style>
</head>
<body>
  <embed id="viewer" src="main.pdf?t=%d" type="application/pdf">
  <script>
    var RELOAD_MS = %d;
    (function poll() {
      setTimeout(function() {
        var e = document.getElementById('viewer');
        e.src = 'main.pdf?t=' + Date.now();
        poll();
      }, RELOAD_MS);
    })();
  </script>
</body>
</html>
"""


class PDFOnlyHandler(SimpleHTTPRequestHandler):
    """Serves only main.pdf and an auto-refresh index page."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if self.path == '/' or self.path == '/index.html':
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.end_headers()
            ts = int(os.path.getmtime(self._pdf_path()) * 1000)
            html = AUTO_REFRESH_HTML % (ts, self.server.reload_ms)
            self.wfile.write(html.encode('utf-8'))
            return

        if self.path.startswith('/main.pdf'):
            pdf = self._pdf_path()
            if os.path.exists(pdf):
                self.send_response(HTTPStatus.OK)
                self.send_header('Content-Type', 'application/pdf')
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.send_header('Pragma', 'no-cache')
                self.send_header('Expires', '0')
                self.end_headers()
                with open(pdf, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self.send_error(HTTPStatus.NOT_FOUND, 'main.pdf not found')
            return

        self.send_error(HTTPStatus.NOT_FOUND, 'Only main.pdf is served')

    def _pdf_path(self):
        return os.path.join(self.server.project_dir, 'main.pdf')

    def log_message(self, format, *args):
        if args and 'main.pdf' in str(args):
            super().log_message(format, *args)


class PDFOnlyServer(HTTPServer):
    allow_reuse_address = True

    def __init__(self, server_address, handler, project_dir, reload_ms=2000):
        self.project_dir = os.path.abspath(project_dir)
        self.reload_ms = reload_ms
        super().__init__(server_address, handler)


def main():
    parser = argparse.ArgumentParser(description='LTC PDF-only HTTP server')
    parser.add_argument('port', nargs='?', type=int, default=8766,
                        help='Port to listen on (default: 8766)')
    parser.add_argument('--dir', default='.',
                        help='Project directory (default: current dir)')
    parser.add_argument('--reload-ms', type=int, default=2000,
                        help='PDF auto-reload interval in ms (default: 2000)')
    args = parser.parse_args()

    project_dir = os.path.abspath(args.dir)
    pdf_path = os.path.join(project_dir, 'main.pdf')
    if not os.path.exists(pdf_path):
        print(f'Warning: {pdf_path} not found. '
              'Compile the project first.')

    server = PDFOnlyServer(('', args.port), PDFOnlyHandler,
                           project_dir, args.reload_ms)
    print(f'LTC PDF Server: http://localhost:{args.port}/')
    print(f'  Serving:      {pdf_path}')
    print(f'  Auto-reload:  {args.reload_ms}ms')
    print(f'  Press Ctrl+C to stop')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down...')
        server.server_close()


if __name__ == '__main__':
    main()
