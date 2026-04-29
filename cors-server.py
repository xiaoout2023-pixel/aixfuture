#!/usr/bin/env python3
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
import json
import os
import threading
import urllib.request
import urllib.error

API_ORIGIN = os.environ.get('API_ORIGIN', 'https://www.aixfutrueapi.top')
STATIC_PORT = int(os.environ.get('STATIC_PORT', 8080))
API_PORT = int(os.environ.get('API_PORT', 8081))


class StaticHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def log_message(self, format, *args):
        print('[STATIC:%d] %s' % (self.server.server_port, format % args))


class APIProxyHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/'):
            self._proxy_request()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path.startswith('/api/'):
            self._proxy_request()
        else:
            self.send_response(404)
            self.end_headers()

    def _proxy_request(self):
        target_url = API_ORIGIN + self.path
        self.log_message('Proxy: %s -> %s', self.path, target_url)
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            req = urllib.request.Request(target_url, data=body, method=self.command)
            req.add_header('Content-Type', self.headers.get('Content-Type', 'application/json'))
            req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36')
            req.add_header('Accept', 'application/json')
            req.add_header('Referer', API_ORIGIN + '/')
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                for key, val in resp.getheaders():
                    if key.lower() in ('content-type',):
                        self.send_header(key, val)
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.log_error('Proxy error: %s', str(e))
            self.send_response(502)
            self.end_headers()
            self.wfile.write(json.dumps({'code': 502, 'message': 'Proxy error: ' + str(e)}).encode())

    def log_message(self, format, *args):
        print('[API:%d] %s' % (self.server.server_port, format % args))


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def start_static_server():
    server = ThreadingHTTPServer(('localhost', STATIC_PORT), StaticHandler)
    print('[STATIC] Static file server on http://localhost:%d/' % STATIC_PORT)
    server.serve_forever()


def start_api_server():
    server = ThreadingHTTPServer(('localhost', API_PORT), APIProxyHandler)
    print('[API] API proxy server on http://localhost:%d/ -> %s' % (API_PORT, API_ORIGIN))
    server.serve_forever()


if __name__ == '__main__':
    print('=' * 60)
    print('AIX Future - Development Server')
    print('=' * 60)
    print('Static:  http://localhost:%d/' % STATIC_PORT)
    print('API:     http://localhost:%d/ -> %s' % (API_PORT, API_ORIGIN))
    print('Leaderboard:  http://localhost:%d/' % STATIC_PORT)
    print('Models:       http://localhost:%d/models.html' % STATIC_PORT)
    print('Calculator:   http://localhost:%d/calculator.html' % STATIC_PORT)
    print('Calc Pro:     http://localhost:%d/calculator-pro.html' % STATIC_PORT)
    print('=' * 60)

    static_server = ThreadingHTTPServer(('localhost', STATIC_PORT), StaticHandler)
    api_server = ThreadingHTTPServer(('localhost', API_PORT), APIProxyHandler)

    static_thread = threading.Thread(target=static_server.serve_forever)
    api_thread = threading.Thread(target=api_server.serve_forever)

    static_thread.start()
    api_thread.start()

    try:
        while True:
            static_thread.join(timeout=1)
            api_thread.join(timeout=1)
    except KeyboardInterrupt:
        print('\nShutting down...')
        static_server.shutdown()
        api_server.shutdown()
        static_thread.join()
        api_thread.join()
        print('Stopped.')
