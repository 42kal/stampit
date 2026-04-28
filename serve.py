#!/usr/bin/env python3
"""StampIt — API + static file server with JSON-persisted state."""
import http.server
import json
import os
import re
import socketserver
import socket as _socket

PORT = int(os.environ.get('PORT', 3000))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

DATA_FILE = 'data.json'

def load_db():
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # Ensure all expected keys exist (handles old/partial files)
        return {
            'customers':  data.get('customers',  {}),
            'businesses': data.get('businesses', {}),
            'cards':      data.get('cards',      {}),
        }
    except (FileNotFoundError, json.JSONDecodeError):
        return {'customers': {}, 'businesses': {}, 'cards': {}}

def save_db():
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(db, f)

# ---- Persistent database (survives server restarts) ----
db = load_db()

def get_local_ip():
    try:
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return 'localhost'

class Handler(http.server.SimpleHTTPRequestHandler):

    # ---------- routing ----------

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/api/'):
            self._api_get(path)
        else:
            super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        self._api_post(path, body)

    # ---------- GET handlers ----------

    def _api_get(self, path):
        m = re.match(r'^/api/business/([^/]+)$', path)
        if m:
            obj = db['businesses'].get(m.group(1))
            return self._json(obj if obj else {'error': 'Not found'}, 200 if obj else 404)

        m = re.match(r'^/api/cards/([^/]+)$', path)
        if m:
            cards = [c for c in db['cards'].values() if c['customerId'] == m.group(1)]
            return self._json(cards)

        m = re.match(r'^/api/members/([^/]+)$', path)
        if m:
            biz_id = m.group(1)
            result = []
            for card in db['cards'].values():
                if card['businessId'] != biz_id:
                    continue
                cust = db['customers'].get(card['customerId'])
                result.append({**card, 'customerName': cust['name'] if cust else 'Unknown'})
            return self._json(result)

        self._json({'error': 'Not found'}, 404)

    # ---------- POST handlers ----------

    def _api_post(self, path, body):

        if path == '/api/register-customer':
            db['customers'][body['id']] = body
            save_db()
            return self._json({'ok': True})

        if path == '/api/register-business':
            db['businesses'][body['id']] = body
            save_db()
            return self._json({'ok': True})

        if path == '/api/join':
            cust_id = body.get('customerId')
            biz_id  = body.get('businessId')
            key     = f"{cust_id}_{biz_id}"
            biz     = db['businesses'].get(biz_id)
            if not biz:
                return self._json({'error': 'Business not found'}, 404)
            already = key in db['cards']
            if not already:
                db['cards'][key] = {
                    'customerId': cust_id, 'businessId': biz_id,
                    'stamps': 0, 'totalVisits': 0, 'rewardsEarned': 0,
                    'joinedAt': body.get('timestamp', 0), 'lastVisit': None
                }
                save_db()
            return self._json({'card': db['cards'][key], 'alreadyMember': already})

        if path == '/api/stamp':
            cust_id = body.get('customerId')
            biz_id  = body.get('businessId')
            count   = max(1, min(20, int(body.get('count', 1))))
            key     = f"{cust_id}_{biz_id}"
            cust    = db['customers'].get(cust_id)
            biz     = db['businesses'].get(biz_id)
            if not cust:
                return self._json({'error': 'Customer not found'}, 404)
            if not biz:
                return self._json({'error': 'Business not found'}, 404)
            # auto-join if first visit
            if key not in db['cards']:
                db['cards'][key] = {
                    'customerId': cust_id, 'businessId': biz_id,
                    'stamps': 0, 'totalVisits': 0, 'rewardsEarned': 0,
                    'joinedAt': body.get('timestamp', 0), 'lastVisit': None
                }
            card = db['cards'][key]
            card['stamps']      += count
            card['totalVisits'] += count
            card['lastVisit']    = body.get('timestamp', 0)
            rewards_earned = 0
            while card['stamps'] >= biz['program']['stampsNeeded']:
                card['stamps']        -= biz['program']['stampsNeeded']
                card['rewardsEarned'] += 1
                rewards_earned        += 1
            save_db()
            return self._json({
                'card':         card,
                'rewardEarned': rewards_earned > 0,
                'rewardsCount': rewards_earned,
                'stampsGiven':  count,
                'customerName': cust['name']
            })

        self._json({'error': 'Not found'}, 404)

    # ---------- helpers ----------

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, fmt, *args):
        # Uncomment to debug requests:
        # print(f"  {self.address_string()} {fmt % args}")
        pass


# ---- Start ----
local_ip = get_local_ip()
socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"""
  +---------------------------------------------------+
  |            StampIt is running!                    |
  +---------------------------------------------------+
  |  Local:    http://localhost:{PORT}                   |
  |  Network:  http://{local_ip}:{PORT}             |
  |                                                   |
  |  Open the Network URL on both phones              |
  |  (phones must be on the same Wi-Fi)               |
  |                                                   |
  |  NOTE: data resets when you stop the server       |
  +---------------------------------------------------+
""")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
