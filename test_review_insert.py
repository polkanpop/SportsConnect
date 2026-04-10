import requests
import json

url = 'https://pfhgiyujvxeartkomrpv.supabase.co'

with open('model_context_and_memory/techstack config/Render/SportsConnect.env') as f:
    for line in f:
        if line.startswith('SUPABASE_SERVICE_ROLE_KEY='):
            srk = line.split('=', 1)[1].strip().strip('"')
            break

base_headers = {
    'apikey': srk,
    'Authorization': f'Bearer {srk}',
    'Prefer': 'return=representation'
}

payload = {
    'userid': 2,
    'targettype': 'court',
    'targetid': 1,
    'rating': 5,
    'comment': 'Great court for practice'
}

print('=== Test 1: CSV format ===')
csv_body = 'userid,targettype,targetid,rating,comment\n2,court,1,5,test'
headers_csv = {**base_headers, 'Content-Type': 'text/csv'}
r = requests.post(f'{url}/rest/v1/reviews', headers=headers_csv, data=csv_body, timeout=15)
print(f'Status: {r.status_code} Body: {r.text}')

print('\n=== Test 2: JSON with explicit columns query param ===')
headers_json = {**base_headers, 'Content-Type': 'application/json'}
r = requests.post(
    f'{url}/rest/v1/reviews?columns=userid,targettype,targetid,rating,comment',
    headers=headers_json, json=payload, timeout=15
)
print(f'Status: {r.status_code} Body: {r.text}')

print('\n=== Test 3: RPC insert_review_bypass ===')
rpc_payload = {'p_userid': 2, 'p_targettype': 'court', 'p_targetid': 1, 'p_rating': 5, 'p_comment': 'test'}
r = requests.post(f'{url}/rest/v1/rpc/insert_review_bypass', headers=headers_json, json=rpc_payload, timeout=15)
print(f'Status: {r.status_code} Body: {r.text}')
